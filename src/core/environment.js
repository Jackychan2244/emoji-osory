const VENDOR_FAMILY_MAP = {
  apple_ios: "ios",
  apple_macos: "macos",
  microsoft_windows: "windows",
  google_android: "android",
  samsung: "android",
  google_noto: "linux",
};

export function getVendorFamily(vendorKey) {
  return VENDOR_FAMILY_MAP[vendorKey] || "unknown";
}

export function inferOsFamilyFromUAChPlatform(platformValue) {
  const normalizedValue = String(platformValue || "").toLowerCase();

  if (!normalizedValue) {
    return "unknown";
  }

  if (
    normalizedValue.includes("ios") ||
    normalizedValue.includes("iphone") ||
    normalizedValue.includes("ipad")
  ) {
    return "ios";
  }

  if (normalizedValue.includes("mac")) {
    return "macos";
  }

  if (normalizedValue.includes("android")) {
    return "android";
  }

  if (normalizedValue.includes("win")) {
    return "windows";
  }

  if (normalizedValue.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

export function inferOsFamilyFromUserAgent(userAgentValue) {
  const normalizedValue = String(userAgentValue || "").toLowerCase();

  if (!normalizedValue) {
    return "unknown";
  }

  if (
    normalizedValue.includes("iphone") ||
    normalizedValue.includes("ipad") ||
    normalizedValue.includes("ipod")
  ) {
    return "ios";
  }

  if (normalizedValue.includes("android")) {
    return "android";
  }

  if (normalizedValue.includes("windows nt")) {
    return "windows";
  }

  if (
    normalizedValue.includes("macintosh") ||
    normalizedValue.includes("mac os x")
  ) {
    return "macos";
  }

  if (normalizedValue.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

export function inferOsFamilyHints(diagnostics = {}) {
  const userAgentDataPlatform = diagnostics.userAgentData?.platform;
  const familyFromUaCh = inferOsFamilyFromUAChPlatform(userAgentDataPlatform);

  if (familyFromUaCh !== "unknown") {
    return {
      family: familyFromUaCh,
      source: "ua_ch",
    };
  }

  const familyFromUserAgent = inferOsFamilyFromUserAgent(diagnostics.userAgent);

  return {
    family: familyFromUserAgent,
    source: familyFromUserAgent === "unknown" ? "unknown" : "user_agent",
  };
}
