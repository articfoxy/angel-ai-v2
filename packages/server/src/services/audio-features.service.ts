/**
 * Pure TypeScript audio feature extraction for voiceprint matching.
 *
 * Operates on raw PCM buffers (linear16, 16 kHz, mono).
 * No external dependencies -- all pure math.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioFeatures {
  rmsEnergy: number;
  zeroCrossingRate: number;
  pitchHz: number;
  spectralCentroid: number;
  spectralRolloff: number;
  /** 13 mel-frequency cepstral-like coefficients */
  mfccLike: number[];
}

// ---------------------------------------------------------------------------
// PCM Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a linear-16 PCM buffer (signed 16-bit LE) to Float64 samples
 * normalised to the range [-1, 1].
 */
export function pcmToFloat(buffer: Buffer): Float64Array {
  const numSamples = buffer.length / 2; // 2 bytes per sample
  const out = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    // readInt16LE returns a signed 16-bit integer (-32768 .. 32767)
    out[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time-domain features
// ---------------------------------------------------------------------------

/**
 * Root mean square energy of the sample buffer.
 * Returns 0 for empty input.
 */
export function computeRms(samples: Float64Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Zero-crossing rate: the fraction of adjacent sample pairs that cross zero.
 * A "crossing" occurs when consecutive samples differ in sign.
 */
export function computeZcr(samples: Float64Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0 && samples[i - 1] < 0) ||
        (samples[i] < 0 && samples[i - 1] >= 0)) {
      crossings++;
    }
  }
  return crossings / (samples.length - 1);
}

// ---------------------------------------------------------------------------
// Pitch detection via autocorrelation
// ---------------------------------------------------------------------------

/**
 * Estimate the fundamental frequency (pitch) using autocorrelation.
 *
 * Searches the lag range corresponding to 80 -- 500 Hz at the given
 * sample rate. Returns 0 when no clear periodic signal is detected
 * (peak autocorrelation < 0.2 of the zero-lag value).
 */
export function computePitch(samples: Float64Array, sampleRate: number): number {
  if (samples.length === 0) return 0;

  // Lag range for 80 -- 500 Hz
  const minLag = Math.floor(sampleRate / 500);
  const maxLag = Math.ceil(sampleRate / 80);

  if (maxLag >= samples.length) return 0;

  // Autocorrelation at zero lag (energy)
  let r0 = 0;
  for (let i = 0; i < samples.length; i++) {
    r0 += samples[i] * samples[i];
  }
  if (r0 === 0) return 0;

  let bestLag = 0;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      sum += samples[i] * samples[i + lag];
    }
    if (sum > bestCorr) {
      bestCorr = sum;
      bestLag = lag;
    }
  }

  // Reject if the peak correlation is weak relative to the energy
  if (bestCorr / r0 < 0.2) return 0;

  return sampleRate / bestLag;
}

// ---------------------------------------------------------------------------
// FFT (in-place, radix-2, Cooley-Tukey)
// ---------------------------------------------------------------------------

/**
 * In-place radix-2 Cooley-Tukey FFT.
 *
 * Both `re` and `im` must have the same power-of-two length.
 * On return they contain the real and imaginary parts of the DFT.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // --- bit-reversal permutation ---
  const halfN = n >> 1;
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      // swap re
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      // swap im
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
    let k = halfN;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // --- butterfly stages ---
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const angle = -2 * Math.PI / size;

    // Twiddle-factor step
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfSize;

        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx];

        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;

        // Advance twiddle factor
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Magnitude spectrum
// ---------------------------------------------------------------------------

/** Return the smallest power of 2 >= n. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Zero-pad the input to the next power-of-two length, run the FFT,
 * and return the magnitude spectrum (first N/2 bins only, i.e. 0 Hz
 * through Nyquist).
 */
export function computeMagnitudeSpectrum(samples: Float64Array): Float64Array {
  const n = nextPow2(samples.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Copy samples into real part; imaginary stays zero (zero-padding is free)
  re.set(samples);

  fft(re, im);

  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

// ---------------------------------------------------------------------------
// Spectral features
// ---------------------------------------------------------------------------

/**
 * Spectral centroid: the weighted mean of frequency bins.
 *
 *   centroid = sum(f_i * |X_i|) / sum(|X_i|)
 *
 * where f_i is the frequency of the i-th bin.
 */
export function computeSpectralCentroid(
  magnitudes: Float64Array,
  sampleRate: number,
): number {
  const binCount = magnitudes.length;
  if (binCount === 0) return 0;

  // The magnitude array has N/2 bins spanning 0 .. sampleRate/2
  const freqPerBin = (sampleRate / 2) / binCount;

  let weightedSum = 0;
  let totalMag = 0;

  for (let i = 0; i < binCount; i++) {
    const freq = i * freqPerBin;
    weightedSum += freq * magnitudes[i];
    totalMag += magnitudes[i];
  }

  return totalMag === 0 ? 0 : weightedSum / totalMag;
}

/**
 * Spectral rolloff: the frequency below which a given fraction of the
 * total spectral energy is concentrated.
 *
 * @param rolloff Fraction of energy (default 0.85 = 85 %).
 */
export function computeSpectralRolloff(
  magnitudes: Float64Array,
  sampleRate: number,
  rolloff = 0.85,
): number {
  const binCount = magnitudes.length;
  if (binCount === 0) return 0;

  const freqPerBin = (sampleRate / 2) / binCount;

  // Total energy (sum of squared magnitudes)
  let totalEnergy = 0;
  for (let i = 0; i < binCount; i++) {
    totalEnergy += magnitudes[i] * magnitudes[i];
  }

  const threshold = rolloff * totalEnergy;
  let cumulative = 0;

  for (let i = 0; i < binCount; i++) {
    cumulative += magnitudes[i] * magnitudes[i];
    if (cumulative >= threshold) {
      return i * freqPerBin;
    }
  }

  return (binCount - 1) * freqPerBin;
}

// ---------------------------------------------------------------------------
// Mel filterbank & MFCC-like coefficients
// ---------------------------------------------------------------------------

/** Convert a frequency in Hz to the mel scale. */
function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

/** Convert a mel value back to Hz. */
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Apply a bank of triangular mel-spaced filters to the magnitude spectrum.
 *
 * @param numFilters Number of mel filters (default 26).
 * @returns An array of filter energies (one per filter).
 */
export function melFilterbank(
  magnitudes: Float64Array,
  sampleRate: number,
  numFilters = 26,
): Float64Array {
  const binCount = magnitudes.length;
  const fftSize = binCount * 2; // magnitude spectrum is N/2 bins from an N-point FFT

  const lowMel = hzToMel(0);
  const highMel = hzToMel(sampleRate / 2);

  // numFilters + 2 points define the triangular filter edges
  const melPoints = new Float64Array(numFilters + 2);
  for (let i = 0; i < numFilters + 2; i++) {
    melPoints[i] = lowMel + (i * (highMel - lowMel)) / (numFilters + 1);
  }

  // Convert mel points to FFT bin indices
  const binIndices = new Float64Array(numFilters + 2);
  for (let i = 0; i < numFilters + 2; i++) {
    const freq = melToHz(melPoints[i]);
    binIndices[i] = Math.floor((fftSize + 1) * freq / sampleRate);
  }

  const filterEnergies = new Float64Array(numFilters);

  for (let m = 0; m < numFilters; m++) {
    const startBin = binIndices[m];
    const centerBin = binIndices[m + 1];
    const endBin = binIndices[m + 2];

    for (let k = Math.max(0, Math.floor(startBin)); k < Math.min(binCount, Math.ceil(endBin)); k++) {
      let weight = 0;
      if (k >= startBin && k <= centerBin && centerBin !== startBin) {
        // Rising slope
        weight = (k - startBin) / (centerBin - startBin);
      } else if (k > centerBin && k <= endBin && endBin !== centerBin) {
        // Falling slope
        weight = (endBin - k) / (endBin - centerBin);
      }
      filterEnergies[m] += magnitudes[k] * weight;
    }
  }

  return filterEnergies;
}

/**
 * DCT-II (unscaled) of an input array, returning the first `numCoeffs`
 * coefficients.
 */
function dctII(input: Float64Array, numCoeffs: number): number[] {
  const n = input.length;
  const out: number[] = [];
  for (let k = 0; k < numCoeffs; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((Math.PI * k * (i + 0.5)) / n);
    }
    out.push(sum);
  }
  return out;
}

/**
 * Compute 13 MFCC-like coefficients from a magnitude spectrum.
 *
 * Pipeline: mel filterbank -> log energy -> DCT-II -> first 13 coefficients.
 */
export function computeMfccLike(
  magnitudes: Float64Array,
  sampleRate: number,
): number[] {
  const filterEnergies = melFilterbank(magnitudes, sampleRate, 26);

  // Log energies (floor at a tiny value to avoid log(0))
  const logEnergies = new Float64Array(filterEnergies.length);
  for (let i = 0; i < filterEnergies.length; i++) {
    logEnergies[i] = Math.log(Math.max(filterEnergies[i], 1e-22));
  }

  return dctII(logEnergies, 13);
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Extract all audio features from a single raw PCM buffer frame.
 *
 * @param pcmBuffer Linear-16, mono PCM data.
 * @param sampleRate Sample rate in Hz (default 16 000).
 */
export function extractFeatures(
  pcmBuffer: Buffer,
  sampleRate = 16000,
): AudioFeatures {
  const samples = pcmToFloat(pcmBuffer);
  const magnitudes = computeMagnitudeSpectrum(samples);

  return {
    rmsEnergy: computeRms(samples),
    zeroCrossingRate: computeZcr(samples),
    pitchHz: computePitch(samples, sampleRate),
    spectralCentroid: computeSpectralCentroid(magnitudes, sampleRate),
    spectralRolloff: computeSpectralRolloff(magnitudes, sampleRate),
    mfccLike: computeMfccLike(magnitudes, sampleRate),
  };
}

/**
 * Extract features from multiple PCM buffer frames and average them
 * (element-wise mean for scalar features, element-wise mean for the
 * mfccLike array).
 *
 * @param pcmBuffers Array of linear-16 mono PCM buffers.
 * @param sampleRate Sample rate in Hz (default 16 000).
 */
export function extractAveragedFeatures(
  pcmBuffers: Buffer[],
  sampleRate = 16000,
): AudioFeatures {
  if (pcmBuffers.length === 0) {
    return {
      rmsEnergy: 0,
      zeroCrossingRate: 0,
      pitchHz: 0,
      spectralCentroid: 0,
      spectralRolloff: 0,
      mfccLike: new Array(13).fill(0),
    };
  }

  const allFeatures = pcmBuffers.map((buf) => extractFeatures(buf, sampleRate));
  const n = allFeatures.length;

  const avgMfcc = new Array(13).fill(0);
  for (const f of allFeatures) {
    for (let i = 0; i < f.mfccLike.length; i++) {
      avgMfcc[i] += f.mfccLike[i];
    }
  }
  for (let i = 0; i < avgMfcc.length; i++) {
    avgMfcc[i] /= n;
  }

  return {
    rmsEnergy: allFeatures.reduce((s, f) => s + f.rmsEnergy, 0) / n,
    zeroCrossingRate: allFeatures.reduce((s, f) => s + f.zeroCrossingRate, 0) / n,
    pitchHz: allFeatures.reduce((s, f) => s + f.pitchHz, 0) / n,
    spectralCentroid: allFeatures.reduce((s, f) => s + f.spectralCentroid, 0) / n,
    spectralRolloff: allFeatures.reduce((s, f) => s + f.spectralRolloff, 0) / n,
    mfccLike: avgMfcc,
  };
}

// ---------------------------------------------------------------------------
// Vectorisation & similarity
// ---------------------------------------------------------------------------

/**
 * Flatten an `AudioFeatures` object into a numeric vector suitable for
 * distance / similarity computations.
 *
 * Scalar features are normalised to roughly [0, 1]:
 *   - pitchHz divided by 500 (max expected pitch)
 *   - spectralCentroid divided by 8000 (Nyquist at 16 kHz)
 *   - spectralRolloff divided by 8000
 *
 * The 13 MFCC-like coefficients are appended as-is.
 */
export function featuresToVector(f: AudioFeatures): number[] {
  return [
    f.rmsEnergy,
    f.zeroCrossingRate,
    f.pitchHz / 500,
    f.spectralCentroid / 8000,
    f.spectralRolloff / 8000,
    ...f.mfccLike,
  ];
}

/**
 * Cosine similarity between two `AudioFeatures` objects.
 *
 * Returns a value in [-1, 1] where 1 means identical feature vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: AudioFeatures, b: AudioFeatures): number {
  const va = featuresToVector(a);
  const vb = featuresToVector(b);

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    magA += va[i] * va[i];
    magB += vb[i] * vb[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
