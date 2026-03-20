import {
  createEmojiIdentifier,
  materializeCodepoints,
} from "../core/materialize.js";

const DEFAULT_CANVAS_SIZE = 56;
const DEFAULT_EMOJI_FONT_SIZE = 34;
const DEFAULT_TOFU_CLUSTER_OPTIONS = {
  enabled: true,
  applyCorrection: true,
  minConsideredTrue: 12,
  minDominantCount: 8,
  minShare: 0.25,
};
const DEFAULT_SUPPORT_DETECTION_OPTIONS = {
  requireColorEmoji: true,
  minimumColorPixelCount: 8,
  minimumColorShare: 0.03,
  minimumChannelSpread: 12,
};

function createUnavailableRenderer(
  reason,
  { blocked = false, spoofing = false } = {},
) {
  return {
    blocked,
    spoofing,
    baselineHashes: [],
    measureGlyph() {
      return {
        hash: 0,
        nonZeroPixelCount: 0,
        colorPixelCount: 0,
        error: new Error(reason),
      };
    },
    isBaselineHash() {
      return true;
    },
    testGlyph() {
      return null;
    },
  };
}

function createCanvasRenderer({
  canvasFactory,
  canvasSize = DEFAULT_CANVAS_SIZE,
  emojiFontSize = DEFAULT_EMOJI_FONT_SIZE,
} = {}) {
  const canvasElement = canvasFactory
    ? canvasFactory()
    : globalThis.document?.createElement("canvas");

  if (!canvasElement) {
    return createUnavailableRenderer("Canvas element is unavailable.", {
      blocked: true,
    });
  }

  const renderingContext = canvasElement.getContext("2d", {
    willReadFrequently: true,
  });

  if (!renderingContext) {
    return createUnavailableRenderer("Canvas 2D context is unavailable.", {
      blocked: true,
    });
  }

  canvasElement.width = canvasSize;
  canvasElement.height = canvasSize;
  renderingContext.textBaseline = "middle";
  renderingContext.textAlign = "center";
  renderingContext.font = `${emojiFontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
  renderingContext.fillStyle = "#101014";

  function renderHash(glyphValue) {
    try {
      renderingContext.clearRect(0, 0, canvasSize, canvasSize);
      renderingContext.fillText(glyphValue, canvasSize / 2, canvasSize / 2);
      const pixelBuffer = renderingContext.getImageData(
        0,
        0,
        canvasSize,
        canvasSize,
      ).data;

      let hashValue = 2166136261;
      let nonZeroPixelCount = 0;
      let colorPixelCount = 0;

      for (let index = 0; index < pixelBuffer.length; index += 1) {
        hashValue ^= pixelBuffer[index];
        hashValue = Math.imul(hashValue, 16777619);

        if ((index & 3) === 3 && pixelBuffer[index] !== 0) {
          nonZeroPixelCount += 1;
        }

        if ((index & 3) === 0) {
          const redValue = pixelBuffer[index];
          const greenValue = pixelBuffer[index + 1];
          const blueValue = pixelBuffer[index + 2];
          const alphaValue = pixelBuffer[index + 3];
          const channelSpread =
            Math.max(redValue, greenValue, blueValue) -
            Math.min(redValue, greenValue, blueValue);

          if (
            alphaValue !== 0 &&
            channelSpread >=
              DEFAULT_SUPPORT_DETECTION_OPTIONS.minimumChannelSpread
          ) {
            colorPixelCount += 1;
          }
        }
      }

      return {
        hash: hashValue >>> 0,
        nonZeroPixelCount,
        colorPixelCount,
      };
    } catch (error) {
      return {
        hash: 0,
        nonZeroPixelCount: 0,
        colorPixelCount: 0,
        error,
      };
    }
  }

  const stabilityProbeValue = String.fromCodePoint(0xffff);
  const firstRead = renderHash(stabilityProbeValue);

  if (firstRead.error) {
    return createUnavailableRenderer("Canvas readback is blocked.", {
      blocked: true,
    });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const repeatedRead = renderHash(stabilityProbeValue);

    if (repeatedRead.error) {
      return createUnavailableRenderer("Canvas readback is blocked.", {
        blocked: true,
      });
    }

    if (repeatedRead.hash !== firstRead.hash) {
      return createUnavailableRenderer("Canvas spoofing detected.", {
        spoofing: true,
      });
    }
  }

  const baselineHashes = new Set();
  const baselineCandidates = [
    String.fromCodePoint(0xffff),
    String.fromCodePoint(0xfffd),
    String.fromCodePoint(0xe000),
    String.fromCodePoint(0x1faff),
    String.fromCodePoint(0x1faff, 0xfe0f),
    String.fromCodePoint(0x1fafe),
    String.fromCodePoint(0x1fafe, 0xfe0f),
  ];

  for (const baselineCandidate of baselineCandidates) {
    const measurement = renderHash(baselineCandidate);

    if (!measurement.error && measurement.nonZeroPixelCount > 0) {
      baselineHashes.add(measurement.hash);
    }
  }

  if (baselineHashes.size === 0) {
    return createUnavailableRenderer("Canvas baseline measurement failed.", {
      blocked: true,
    });
  }

  return {
    blocked: false,
    spoofing: false,
    baselineHashes: [...baselineHashes],
    measureGlyph(glyphValue) {
      return renderHash(glyphValue);
    },
    isBaselineHash(hashValue) {
      return baselineHashes.has(hashValue);
    },
    testGlyph(glyphValue) {
      const measurement = renderHash(glyphValue);

      if (measurement.error || measurement.nonZeroPixelCount === 0) {
        return null;
      }

      return baselineHashes.has(measurement.hash) ? false : true;
    },
  };
}

function computeTofuCluster(
  measurementMap,
  tofuClusterOptions,
  renderer,
  sentinelResults,
) {
  const consideredMeasurements = Object.entries(measurementMap).filter(
    ([sentinelIdentifier, measurement]) =>
      sentinelResults[sentinelIdentifier] === true &&
      measurement &&
      typeof measurement.hash === "number" &&
      measurement.nonZeroPixelCount > 0 &&
      !renderer.isBaselineHash(measurement.hash),
  );

  if (consideredMeasurements.length === 0) {
    return {
      suspected: false,
      applied: false,
      consideredTrueCount: 0,
      dominantCount: 0,
      share: 0,
      dominantHash: null,
      correctedSentinelIds: [],
    };
  }

  const hashCounts = new Map();

  for (const [, measurement] of consideredMeasurements) {
    hashCounts.set(
      measurement.hash,
      (hashCounts.get(measurement.hash) || 0) + 1,
    );
  }

  let dominantHash = null;
  let dominantCount = 0;

  for (const [hashValue, occurrenceCount] of hashCounts.entries()) {
    if (occurrenceCount > dominantCount) {
      dominantHash = hashValue;
      dominantCount = occurrenceCount;
    }
  }

  const share = dominantCount / consideredMeasurements.length;
  const suspected =
    consideredMeasurements.length >= tofuClusterOptions.minConsideredTrue &&
    dominantCount >= tofuClusterOptions.minDominantCount &&
    share >= tofuClusterOptions.minShare;

  const correctedSentinelIds = [];

  if (suspected && tofuClusterOptions.applyCorrection) {
    for (const [sentinelIdentifier, measurement] of consideredMeasurements) {
      if (measurement.hash === dominantHash) {
        sentinelResults[sentinelIdentifier] = false;
        correctedSentinelIds.push(sentinelIdentifier);
      }
    }
  }

  return {
    suspected,
    applied: suspected && tofuClusterOptions.applyCorrection,
    consideredTrueCount: consideredMeasurements.length,
    dominantCount,
    share: Number(share.toFixed(4)),
    dominantHash,
    correctedSentinelIds,
  };
}

function isEmojiLikeMeasurement(measurement, supportDetectionOptions) {
  if (!measurement || measurement.nonZeroPixelCount === 0) {
    return false;
  }

  if (supportDetectionOptions.requireColorEmoji === false) {
    return true;
  }

  const colorShare =
    measurement.colorPixelCount / measurement.nonZeroPixelCount;

  return (
    measurement.colorPixelCount >=
      supportDetectionOptions.minimumColorPixelCount &&
    colorShare >= supportDetectionOptions.minimumColorShare
  );
}

export function createBrowserProbe({
  navigatorObject = globalThis.navigator,
  rendererFactory,
  tofuClusterOptions = {},
  supportDetectionOptions = {},
  canvasSize,
  emojiFontSize,
} = {}) {
  const resolvedTofuClusterOptions = {
    ...DEFAULT_TOFU_CLUSTER_OPTIONS,
    ...(tofuClusterOptions || {}),
  };
  const resolvedSupportDetectionOptions = {
    ...DEFAULT_SUPPORT_DETECTION_OPTIONS,
    ...(supportDetectionOptions || {}),
  };

  function createRenderer() {
    if (typeof rendererFactory === "function") {
      return rendererFactory();
    }

    return createCanvasRenderer({
      canvasSize,
      emojiFontSize,
    });
  }

  async function run(runtimeDataset) {
    const renderer = createRenderer();
    const sentinelResults = {};
    const measurementMap = {};
    const monochromeFallbackSentinelIds = [];
    const runtimeSentinels = runtimeDataset.sentinels || {};

    for (const [sentinelIdentifier, sentinelRecord] of Object.entries(
      runtimeSentinels,
    )) {
      const glyphValue = materializeCodepoints(sentinelRecord.codepoints);
      const measurement = renderer.measureGlyph(glyphValue);
      measurementMap[sentinelIdentifier] = measurement;

      if (measurement.error || measurement.nonZeroPixelCount === 0) {
        sentinelResults[sentinelIdentifier] = null;
        continue;
      }

      if (renderer.isBaselineHash(measurement.hash)) {
        sentinelResults[sentinelIdentifier] = false;
        continue;
      }

      if (
        !isEmojiLikeMeasurement(measurement, resolvedSupportDetectionOptions)
      ) {
        sentinelResults[sentinelIdentifier] = false;
        monochromeFallbackSentinelIds.push(sentinelIdentifier);
        continue;
      }

      sentinelResults[sentinelIdentifier] = true;
    }

    const tofuCluster = resolvedTofuClusterOptions.enabled
      ? computeTofuCluster(
          measurementMap,
          resolvedTofuClusterOptions,
          renderer,
          sentinelResults,
        )
      : null;

    const userAgentData =
      navigatorObject &&
      navigatorObject.userAgentData &&
      typeof navigatorObject.userAgentData === "object"
        ? {
            brands: navigatorObject.userAgentData.brands || [],
            mobile: Boolean(navigatorObject.userAgentData.mobile),
            platform: navigatorObject.userAgentData.platform || null,
          }
        : null;

    return {
      sentinelResults,
      diagnostics: {
        userAgent: navigatorObject?.userAgent || "",
        canvasBlocked: Boolean(renderer.blocked),
        spoofingDetected: Boolean(renderer.spoofing),
        tofuCluster,
        tofuBaselineHashes: Array.isArray(renderer.baselineHashes)
          ? renderer.baselineHashes
          : [],
        monochromeFallbackCount: monochromeFallbackSentinelIds.length,
        userAgentData,
      },
      measurements: Object.fromEntries(
        Object.entries(measurementMap).map(
          ([sentinelIdentifier, measurement]) => [
            sentinelIdentifier,
            {
              hash:
                typeof measurement.hash === "number" ? measurement.hash : null,
              nonZeroPixelCount:
                typeof measurement.nonZeroPixelCount === "number"
                  ? measurement.nonZeroPixelCount
                  : 0,
              colorPixelCount:
                typeof measurement.colorPixelCount === "number"
                  ? measurement.colorPixelCount
                  : 0,
              error: measurement.error ? measurement.error.message : null,
            },
          ],
        ),
      ),
    };
  }

  return {
    createEmojiIdentifier,
    run,
  };
}
