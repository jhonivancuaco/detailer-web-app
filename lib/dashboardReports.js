import connectDB from "@/lib/db";
import ActivityLog from "@/models/ActivityLog";
import Product from "@/models/Product";
import SlideRetention from "@/models/SlideRetention";
import User from "@/models/User";
import { getReportDivisionLabel } from "@/lib/reportDivision";
import { getUserAccessType } from "@/lib/userAccess";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_KEYS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DASHBOARD_SOURCE_CACHE_TTL_MS = 15 * 1000;
const dashboardSourceCache = new Map();

const EMPTY_FILTER_VALUE = "All";
const UNKNOWN_PRODUCT_LABEL = "Unknown Product";
const normalizeText = (value) => String(value || "").trim();
const normalizeBrandKey = (value) => normalizeText(value).toLowerCase();
const UNASSIGNED_TEAM_LABEL = "Unassigned Team";
const UNKNOWN_REPRESENTATIVE_LABEL = "Unknown Representative";
const ADMIN_USERS_TEAM_LABEL = "Admin Users";
const MARKETING_TEAM_LABEL = "Marketing Team";
const EXCLUDED_USAGE_DIVISION_LABELS = new Set(["Office", "Marketing", "Training"]);
const EXCLUDED_USAGE_TEAM_LABELS = new Set([ADMIN_USERS_TEAM_LABEL, MARKETING_TEAM_LABEL]);
const isExcludedBrandFilterOption = (value) => {
  const key = normalizeBrandKey(value);
  if (!key) return false;
  if (key === "unknown brand") return true;
  // Hide staging/demo labels used for test content.
  return key.includes("test product") || key.includes("local test") || key.startsWith("demo product");
};

const uniqueSorted = (values) =>
  Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );

const sumValues = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const isDateAfterCutoff = (value, cutoffTime) => value.getTime() > cutoffTime;

const incrementMap = (map, key, amount = 1) => {
  map.set(key, (map.get(key) || 0) + amount);
};

const buildPercentRows = (map, limit = 6, options = {}) => {
  const { rawValueKey = "rawValue", rawValueTransform = (value) => value, includeLabels = [] } = options;
  const rowsByKey = new Map();

  (Array.isArray(includeLabels) ? includeLabels : []).forEach((label) => {
    const normalizedLabel = normalizeText(label);
    if (!normalizedLabel) return;

    rowsByKey.set(normalizeComparableText(normalizedLabel), {
      label: normalizedLabel,
      value: 0,
      isRequired: true,
    });
  });

  Array.from(map.entries()).forEach(([label, value]) => {
    const normalizedLabel = normalizeText(label);
    if (!normalizedLabel) return;

    const comparableKey = normalizeComparableText(normalizedLabel);
    const current = rowsByKey.get(comparableKey);
    rowsByKey.set(comparableKey, {
      label: current?.label || normalizedLabel,
      value: Number(current?.value || 0) + Number(value || 0),
      isRequired: Boolean(current?.isRequired),
    });
  });

  const sortedRows = Array.from(rowsByKey.values())
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .filter((row) => row.value > 0 || row.isRequired);

  const requiredRows = sortedRows.filter((row) => row.isRequired);
  const optionalRows = sortedRows.filter((row) => !row.isRequired);
  const rows =
    Number.isFinite(limit) && limit > 0
      ? [...requiredRows, ...optionalRows.slice(0, Math.max(0, limit - requiredRows.length))]
          .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
      : sortedRows;

  const total = sumValues(rows.map((row) => row.value));
  if (!total) {
    return rows.map((row) => ({
      label: row.label,
      value: 0,
      [rawValueKey]: Number(rawValueTransform(0).toFixed(2)),
    }));
  }

  return rows.map((row) => ({
    label: row.label,
    value: row.value > 0 ? Math.max(1, Math.round((row.value / total) * 100)) : 0,
    [rawValueKey]: Number(rawValueTransform(row.value).toFixed(2)),
  }));
};

const cleanModuleLabel = (value) =>
  normalizeText(value)
    .replace(/^[0-9]+(?:-[0-9]+)+-/, "")
    .replace(/\.(pdf|ppt|pptx|html?)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cleanSlideDisplayName = (value) =>
  cleanModuleLabel(value)
    .replace(/\.(png|jpe?g|webp|gif)$/i, "")
    .replace(/(?:^|\s)(slide|page)\s*\d+$/i, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeLookupKey = (value) =>
  cleanModuleLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getFilenameFromUrl = (value) => {
  const raw = normalizeText(value).split("#")[0].split("?")[0];
  if (!raw) return "";
  return raw.split("/").pop() || raw;
};

const getPageNumberFromFilename = (filename = "") => {
  const value = String(filename || "");
  const namedMatch = value.match(/(?:^|[._\-\s])(page|slide)[._\-\s]?(\d+)(?=\.[^.]+$|$)/i);
  if (namedMatch) {
    const parsed = Number.parseInt(namedMatch[2], 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const trailingMatch = value.match(/(\d+)(?=\.[^.]+$|$)/);
  if (!trailingMatch) return null;
  const parsed = Number.parseInt(trailingMatch[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const getMediaSortKey = (item) => {
  const titleFilename = getFilenameFromUrl(item?.title || "");
  const urlFilename = getFilenameFromUrl(item?.url || "");
  const thumbnailFilename = getFilenameFromUrl(item?.thumbnailUrl || "");

  return titleFilename || urlFilename || thumbnailFilename || normalizeText(item?.title) || normalizeText(item?.url);
};

const sortMediaItemsBySlideOrder = (left, right) => {
  const leftSortKey = getMediaSortKey(left);
  const rightSortKey = getMediaSortKey(right);
  const leftPage = getPageNumberFromFilename(leftSortKey);
  const rightPage = getPageNumberFromFilename(rightSortKey);

  if (leftPage !== null && rightPage !== null && leftPage !== rightPage) {
    return leftPage - rightPage;
  }

  return String(leftSortKey).localeCompare(String(rightSortKey), undefined, {
    numeric: true,
    sensitivity: "base",
  });
};

const getMediaExportName = (item) => {
  const titleFilename = getFilenameFromUrl(item?.title || "");
  if (titleFilename) return titleFilename;

  const urlFilename = getFilenameFromUrl(item?.url || "");
  if (urlFilename) return urlFilename;

  return normalizeText(item?.title);
};

const getCanonicalMediaLabelFromItems = (items) =>
  uniqueSorted(
    (Array.isArray(items) ? items : []).map((item) => cleanModuleLabel(item?.groupTitle || item?.sourceName || item?.title))
  )[0] || "";

const findMatchingMediaItems = (product, record = {}) => {
  const media = Array.isArray(product?.media) ? product.media : [];
  if (!media.length) return [];

  const exactGroupIds = uniqueSorted([record?.groupId, record?.deckId, record?.caseId]);
  for (const groupId of exactGroupIds) {
    const groupMatches = media.filter((item) => normalizeText(item?.groupId) === groupId);
    if (groupMatches.length) return groupMatches;
  }

  const lookupCandidates = uniqueSorted([
    record?.deckTitle,
    record?.presentationTitle,
    record?.caseName,
    record?.sourceName,
    record?.groupTitle,
    record?.title,
    record?.groupId,
    record?.deckId,
    record?.caseId,
  ]);

  for (const candidate of lookupCandidates) {
    const candidateKey = normalizeLookupKey(candidate);
    if (!candidateKey) continue;

    const groupedMatches = media.filter((item) => {
      const itemCandidates = [item?.groupTitle, item?.sourceName, item?.title, item?.groupId];
      return itemCandidates.some((itemCandidate) => {
        const itemKey = normalizeLookupKey(itemCandidate);
        return itemKey && (itemKey === candidateKey || itemKey.includes(candidateKey) || candidateKey.includes(itemKey));
      });
    });
    if (groupedMatches.length) return groupedMatches;
  }

  return [];
};

const resolveCanonicalMediaLabel = (product, record = {}) => {
  const matchedItems = findMatchingMediaItems(product, record);
  return getCanonicalMediaLabelFromItems(matchedItems);
};

const getRetentionMediaItems = (record, product) => {
  const matchedItems = findMatchingMediaItems(product, record);
  if (matchedItems.length) return matchedItems;
  return Array.isArray(product?.media) ? product.media : [];
};

const resolveRetentionSlideExportName = (record, product) => {
  const rawSlideTitle = normalizeText(record?.slideTitle);
  const slideNumber = Number.isFinite(Number(record?.slideNumber))
    ? Math.max(1, Math.round(Number(record.slideNumber)))
    : Math.max(1, Math.round(Number(record?.slideIndex || 0)) + 1);

  const mediaItems = getRetentionMediaItems(record, product);
  if (mediaItems.length) {
    const sortedItems = [...mediaItems].sort(sortMediaItemsBySlideOrder);
    const matchedItem = sortedItems[slideNumber - 1];
    const matchedName = getMediaExportName(matchedItem);
    if (matchedName) return matchedName;
  }

  return rawSlideTitle || `Slide ${slideNumber}`;
};

const toMaterialName = ({ attachment, slide, brand }) => {
  const attachmentValue = normalizeText(attachment);
  const slideValue = normalizeText(slide);
  const brandValue = normalizeText(brand);
  const source = attachmentValue || slideValue;
  if (!source) return "UNKNOWN MATERIAL";

  const withoutExtension = source.replace(/\.[a-z0-9]{2,5}$/i, "");
  const withoutSlideSuffix = withoutExtension.replace(/(?:^|[\s_-])(slide|page)[\s_-]*\d+$/i, "");
  const tokens = withoutSlideSuffix
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const dedupedTokens = [];
  tokens.forEach((token) => {
    const previous = dedupedTokens[dedupedTokens.length - 1];
    if (previous && previous.toLowerCase() === token.toLowerCase()) return;
    dedupedTokens.push(token);
  });

  if (!dedupedTokens.length) return "UNKNOWN MATERIAL";

  // Keep material clean when filename begins with duplicated brand token (e.g., "meptin-meptin-...").
  if (brandValue && dedupedTokens.length >= 2) {
    const brandLower = brandValue.toLowerCase();
    if (dedupedTokens[0].toLowerCase() === brandLower && dedupedTokens[1].toLowerCase() === brandLower) {
      dedupedTokens.splice(1, 1);
    }
  }

  return dedupedTokens.join(" ").toUpperCase();
};

const isUnassignedTeam = (value) =>
  normalizeComparableText(value) === normalizeComparableText(UNASSIGNED_TEAM_LABEL);

const isUnknownRepresentative = (value) =>
  normalizeComparableText(value) === normalizeComparableText(UNKNOWN_REPRESENTATIVE_LABEL);

const resolveOfficeTeamLabel = (user) => {
  const roleLabel = normalizeText(user?.role);
  const normalizedRole = normalizeComparableText(roleLabel);
  const accessType = getUserAccessType(user);

  if (accessType === "admin" || normalizedRole === "admin" || normalizedRole === "admin users" || normalizedRole.startsWith("admin ")) {
    return ADMIN_USERS_TEAM_LABEL;
  }
  if (normalizedRole.includes("marketing")) return MARKETING_TEAM_LABEL;

  return "";
};

const getTeamLabel = (user) =>
  resolveOfficeTeamLabel(user) || normalizeText(user?.role) || UNASSIGNED_TEAM_LABEL;

const getRepLabel = (user) => {
  const name = normalizeText(user?.name);
  const username = normalizeText(user?.username);
  const repId = normalizeText(user?.repId);

  if (name && username && name.toLowerCase() !== username.toLowerCase()) return `${name} / ${username}`;
  return name || username || repId || "Unknown Representative";
};

const getBrandLabel = (product, details) =>
  normalizeText(product?.brandName) ||
  normalizeText(details?.brandName) ||
  normalizeText(details?.productName) ||
  normalizeText(product?.name) ||
  "Unknown Brand";

const getDivisionLabel = (user) => getReportDivisionLabel(user?.division);

const isUsageExcludedUser = (user) => {
  if (!user || typeof user !== "object") return false;

  const division = getDivisionLabel(user);
  if (EXCLUDED_USAGE_DIVISION_LABELS.has(division)) return true;

  return EXCLUDED_USAGE_TEAM_LABELS.has(getTeamLabel(user));
};

const getEventLookupCandidates = (event) => {
  const details = event?.details || {};
  return [
    details.productId,
    details.productName,
    details.brandName,
    event?.deckTitle,
    details.deckTitle,
    details.presentationTitle,
    details.caseName,
    details.caseId,
    details.deckId,
    details.sourceName,
    details.groupTitle,
    details.title,
  ];
};

const buildProductLookup = (products) => {
  const exact = new Map();
  const fuzzy = [];

  const addAlias = (product, value) => {
    const key = normalizeLookupKey(value);
    if (!key) return;

    if (!exact.has(key)) exact.set(key, product);
    if (key.length >= 5) {
      fuzzy.push({ key, product });
    }
  };

  products.forEach((product) => {
    addAlias(product, product?._id);
    addAlias(product, product?.name);
    addAlias(product, product?.brandName);
    addAlias(product, product?.category);

    (Array.isArray(product?.media) ? product.media : []).forEach((media) => {
      addAlias(product, media?.sourceName);
      addAlias(product, media?.groupTitle);
      addAlias(product, media?.title);
    });
  });

  fuzzy.sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key));

  return {
    exact,
    fuzzy,
  };
};

const findProductByLookup = (lookup, value) => {
  const key = normalizeLookupKey(value);
  if (!key) return null;

  const exactMatch = lookup.exact.get(key);
  if (exactMatch) return exactMatch;

  const fuzzyMatch = lookup.fuzzy.find((entry) => key.includes(entry.key) || entry.key.includes(key));
  return fuzzyMatch?.product || null;
};

const resolveEventProduct = (event, productById, productLookup) => {
  const details = event?.details || {};
  const directProductId = normalizeText(details.productId);
  if (directProductId) {
    const directProduct = productById.get(directProductId);
    if (directProduct) return directProduct;
  }

  for (const candidate of getEventLookupCandidates(event)) {
    const matchedProduct = findProductByLookup(productLookup, candidate);
    if (matchedProduct) return matchedProduct;
  }

  return null;
};

const getRetentionLookupCandidates = (record) => {
  const details = record?.details || {};
  return [
    record?.presentationId,
    record?.caseId,
    record?.deckId,
    record?.presentationTitle,
    record?.deckTitle,
    record?.slideTitle,
    details.productId,
    details.productName,
    details.brandName,
    details.deckTitle,
    details.presentationTitle,
    details.caseId,
    details.deckId,
  ];
};

const resolveRetentionProduct = (record, productById, productLookup) => {
  const directProductId = normalizeText(record?.presentationId);
  if (directProductId) {
    const directProduct = productById.get(directProductId);
    if (directProduct) return directProduct;
  }

  for (const candidate of getRetentionLookupCandidates(record)) {
    const matchedProduct = findProductByLookup(productLookup, candidate);
    if (matchedProduct) return matchedProduct;
  }

  return null;
};

const buildProductModuleFallback = (product, brand) => {
  const mediaNames = uniqueSorted(
    (Array.isArray(product?.media) ? product.media : []).map((media) =>
      cleanModuleLabel(media?.groupTitle || media?.sourceName || media?.title)
    )
  );
  if (mediaNames.length === 1) return mediaNames[0];
  return brand;
};

const getModuleLabel = (event, product, brand) => {
  const details = event?.details || {};
  const canonicalMediaLabel = resolveCanonicalMediaLabel(product, {
    deckTitle: event?.deckTitle || details?.deckTitle,
    presentationTitle: details?.presentationTitle,
    caseName: details?.caseName,
    sourceName: details?.sourceName,
    groupTitle: details?.groupTitle,
    title: details?.title,
    deckId: details?.deckId,
    caseId: details?.caseId,
  });
  if (canonicalMediaLabel) return canonicalMediaLabel;

  const candidates = [
    event?.deckTitle,
    details.deckTitle,
    details.presentationTitle,
    details.caseName,
    details.deckId,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanModuleLabel(candidate);
    if (cleaned) return cleaned;
  }

  return buildProductModuleFallback(product, brand);
};

const getMaterialLabel = (event, product, brand) => {
  const details = event?.details || {};
  const canonicalMediaLabel = resolveCanonicalMediaLabel(product, {
    deckTitle: details?.deckTitle || event?.deckTitle,
    presentationTitle: details?.presentationTitle,
    caseName: details?.caseName,
    sourceName: details?.sourceName,
    groupTitle: details?.groupTitle,
    title: details?.title,
    deckId: details?.deckId,
    caseId: details?.caseId,
  });
  if (canonicalMediaLabel) return canonicalMediaLabel;

  const candidates = [
    details.deckTitle,
    details.presentationTitle,
    event?.deckTitle,
    details.caseName,
    details.deckId,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanModuleLabel(candidate);
    if (cleaned) return cleaned;
  }

  return buildProductModuleFallback(product, brand);
};

const isMaterialOpenedEvent = (event) => normalizeText(event?.action).toLowerCase() === "material_opened";
const isMaterialClosedEvent = (event) => normalizeText(event?.action).toLowerCase() === "material_closed";
const LEGACY_SLIDE_ACTIVITY_ACTIONS = new Set([
  "presentation_slide_view",
  "slide_changed",
  "thumbnail_selected",
  "swipe_slide",
  "hotspot_tapped",
]);

const isLegacySlideActivityEvent = (event) => {
  const action = normalizeText(event?.action).toLowerCase();
  const screen = normalizeText(event?.screen).toLowerCase();
  return LEGACY_SLIDE_ACTIVITY_ACTIONS.has(action) || (screen === "presentation-viewer" && /slide|thumbnail|hotspot/.test(action));
};

const parseEventTime = (value, fallback = null) => {
  const parsed = new Date(value || fallback || 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeComparableText = (value) => normalizeText(value).toLowerCase();
const isUnknownProduct = (value) =>
  normalizeComparableText(value) === normalizeComparableText(UNKNOWN_PRODUCT_LABEL);

const buildMaterialUsageSessions = (records) => {
  const byUseKey = new Map();

  records.forEach((record) => {
    const materialUseKey = normalizeText(record?.materialUseKey);
    if (!materialUseKey) return;
    const productName = normalizeText(record?.productName || record?.product);
    if (!productName || isUnknownProduct(productName)) return;

    const current = byUseKey.get(materialUseKey) || {
      materialUseKey,
      sessionId: normalizeText(record?.sessionId),
      date: normalizeText(record?.date) || "-",
      year: normalizeText(record?.year) || "-",
      month: normalizeText(record?.month) || "-",
      team: normalizeText(record?.team) || "Unassigned Team",
      psr: normalizeText(record?.psr) || "Unknown Representative",
      brand: normalizeText(record?.brand) || "Unknown Brand",
      productName,
      deckId: normalizeText(record?.deckId || record?.caseId),
      material: normalizeText(record?.material) || "UNKNOWN MATERIAL",
      timeOpenedAt: null,
      timeClosedAt: null,
    };

    const openedAtMs = parseEventTime(record?.timeOpenedAt)?.getTime() || null;
    const closedAtMs = parseEventTime(record?.timeClosedAt)?.getTime() || null;

    if (!current.sessionId) current.sessionId = normalizeText(record?.sessionId);
    if (!current.deckId) current.deckId = normalizeText(record?.deckId || record?.caseId);
    if (!current.productName) current.productName = productName;

    if (openedAtMs && (!current.timeOpenedAt || openedAtMs < current.timeOpenedAt)) {
      current.timeOpenedAt = openedAtMs;
    }
    if (closedAtMs && (!current.timeClosedAt || closedAtMs > current.timeClosedAt)) {
      current.timeClosedAt = closedAtMs;
    }

    byUseKey.set(materialUseKey, current);
  });

  return Array.from(byUseKey.values()).sort(
    (left, right) =>
      Number(left.timeOpenedAt || left.timeClosedAt || 0) - Number(right.timeOpenedAt || right.timeClosedAt || 0)
  );
};

const addMaterialUsageIndexEntry = (index, key, usage) => {
  if (!key) return;
  const entries = index.get(key) || [];
  entries.push(usage);
  index.set(key, entries);
};

const buildMaterialUsageLookup = (usageSessions) => {
  const byMaterial = new Map();
  const byMaterialSession = new Map();

  (Array.isArray(usageSessions) ? usageSessions : []).forEach((usage) => {
    const materialKey = normalizeComparableText(usage?.material);
    if (!materialKey) return;

    addMaterialUsageIndexEntry(byMaterial, materialKey, usage);

    const sessionKey = normalizeComparableText(usage?.sessionId);
    if (sessionKey) {
      addMaterialUsageIndexEntry(byMaterialSession, `${materialKey}||${sessionKey}`, usage);
    }
  });

  return {
    byMaterial,
    byMaterialSession,
  };
};

const getMaterialUsageCandidatePool = (usageSource, materialKey, sessionKey) => {
  if (usageSource?.byMaterial && usageSource?.byMaterialSession) {
    const sessionCandidates = sessionKey ? usageSource.byMaterialSession.get(`${materialKey}||${sessionKey}`) : null;
    if (Array.isArray(sessionCandidates) && sessionCandidates.length > 0) {
      return sessionCandidates;
    }

    return usageSource.byMaterial.get(materialKey) || [];
  }

  return Array.isArray(usageSource) ? usageSource : [];
};

const findMatchingMaterialUsage = (usageSource, record) => {
  const materialKey = normalizeComparableText(record?.material);
  if (!materialKey) return null;

  const sessionKey = normalizeComparableText(record?.sessionId);
  const dateKey = normalizeComparableText(record?.date);
  const deckKey = normalizeComparableText(record?.deckId || record?.caseId);
  const psrKey = normalizeComparableText(record?.psr);
  const productKey = normalizeComparableText(record?.productName || record?.product);
  const brandKey = normalizeComparableText(record?.brand);
  const startedAtMs = Number(record?.startedAtMs || 0);
  const endedAtMs = Number(record?.endedAtMs || 0);
  const rangeStart = startedAtMs > 0 ? startedAtMs : endedAtMs;
  const rangeEnd = endedAtMs > 0 ? endedAtMs : startedAtMs;
  const candidatePool = getMaterialUsageCandidatePool(usageSource, materialKey, sessionKey);

  const candidates = candidatePool.filter((usage) => {
    if (normalizeComparableText(usage.material) !== materialKey) return false;
    if (sessionKey && normalizeComparableText(usage.sessionId) && normalizeComparableText(usage.sessionId) !== sessionKey) return false;
    if (dateKey && normalizeComparableText(usage.date) && normalizeComparableText(usage.date) !== dateKey) return false;
    if (deckKey && normalizeComparableText(usage.deckId) && normalizeComparableText(usage.deckId) !== deckKey) return false;
    if (psrKey && normalizeComparableText(usage.psr) && normalizeComparableText(usage.psr) !== psrKey) return false;
    if (productKey && normalizeComparableText(usage.productName) && normalizeComparableText(usage.productName) !== productKey) return false;
    if (brandKey && normalizeComparableText(usage.brand) && normalizeComparableText(usage.brand) !== brandKey) return false;
    return true;
  });

  if (!candidates.length) return null;

  const overlappingCandidates = candidates.filter((usage) => {
    const usageStart = Number(usage.timeOpenedAt || usage.timeClosedAt || 0);
    const usageEnd = Number(usage.timeClosedAt || usage.timeOpenedAt || 0);
    if (!(rangeStart > 0) || !(usageStart > 0)) return false;
    return rangeStart <= usageEnd + 1000 && rangeEnd >= usageStart - 1000;
  });

  const pool = overlappingCandidates.length ? overlappingCandidates : candidates;
  return pool.sort((left, right) => {
    const leftStart = Number(left.timeOpenedAt || left.timeClosedAt || 0);
    const rightStart = Number(right.timeOpenedAt || right.timeClosedAt || 0);
    return Math.abs(leftStart - rangeStart) - Math.abs(rightStart - rangeStart);
  })[0] || null;
};

const buildMaterialOpenExportRows = (records = []) =>
  (Array.isArray(records) ? records : [])
    .map((record) => {
      const productName = normalizeText(record?.productName || record?.product);
      if (!productName || isUnknownProduct(productName)) return null;

      return {
        date: normalizeText(record?.date) || "-",
        year: normalizeText(record?.year) || "-",
        month: normalizeText(record?.month) || "-",
        team: normalizeText(record?.team) || "Unassigned Team",
        psr: normalizeText(record?.psr) || "Unknown Representative",
        brand: normalizeText(record?.brand) || "Unknown Brand",
        productName,
        material: normalizeText(record?.material) || "UNKNOWN MATERIAL",
        sessionId: normalizeText(record?.sessionId),
        deckId: normalizeText(record?.deckId || record?.caseId),
        materialUseKey: normalizeText(record?.materialUseKey),
        timeOpenedAt: parseEventTime(record?.timeOpenedAt)?.toISOString() || "",
        timeClosedAt: parseEventTime(record?.timeClosedAt)?.toISOString() || "",
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        String(left.date).localeCompare(String(right.date)) ||
        String(left.timeOpenedAt || "").localeCompare(String(right.timeOpenedAt || "")) ||
        String(left.timeClosedAt || "").localeCompare(String(right.timeClosedAt || "")) ||
        String(left.month).localeCompare(String(right.month)) ||
        String(left.team).localeCompare(String(right.team)) ||
        String(left.psr).localeCompare(String(right.psr)) ||
        String(left.brand).localeCompare(String(right.brand)) ||
        String(left.material).localeCompare(String(right.material))
    );

const buildMaterialOpenCountExportRows = (records = []) => {
  const grouped = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    const productName = normalizeText(record?.productName || record?.product);
    if (!productName || isUnknownProduct(productName)) return;

    const row = {
      date: normalizeText(record?.date) || "-",
      year: normalizeText(record?.year) || "-",
      month: normalizeText(record?.month) || "-",
      team: normalizeText(record?.team) || "Unassigned Team",
      psr: normalizeText(record?.psr) || "Unknown Representative",
      brand: normalizeText(record?.brand) || "Unknown Brand",
      productName,
      material: normalizeText(record?.material) || "UNKNOWN MATERIAL",
    };
    const key = [
      row.date,
      row.year,
      row.month,
      row.team,
      row.psr,
      row.brand,
      row.productName,
      row.material,
    ].join("||");
    const current = grouped.get(key) || {
      ...row,
      openCountPerDay: 0,
    };

    current.openCountPerDay += 1;
    grouped.set(key, current);
  });

  return Array.from(grouped.values()).sort(
    (left, right) =>
      String(left.date).localeCompare(String(right.date)) ||
      String(left.month).localeCompare(String(right.month)) ||
      String(left.team).localeCompare(String(right.team)) ||
      String(left.psr).localeCompare(String(right.psr)) ||
      String(left.brand).localeCompare(String(right.brand)) ||
      String(left.productName).localeCompare(String(right.productName)) ||
      String(left.material).localeCompare(String(right.material))
  );
};

const isMeaningfulEvent = (event) => {
  const action = normalizeText(event?.action).toLowerCase();
  const screen = normalizeText(event?.screen).toLowerCase();

  if (!action && !screen) return false;
  if (screen === "presentation") return true;
  if (screen === "presentation-viewer") return true;
  if (action === "product_opened") return true;
  return /(presentation|thumbnail|slide|deck|viewer|detailer|product_opened)/.test(action);
};

const buildMatchesFilter = (filters) => (record) => {
  if (filters.division !== EMPTY_FILTER_VALUE && record.division !== filters.division) return false;
  if (filters.team !== EMPTY_FILTER_VALUE && record.team !== filters.team) return false;
  if (filters.psr !== EMPTY_FILTER_VALUE && record.psr !== filters.psr) return false;
  if (filters.brand !== EMPTY_FILTER_VALUE && record.brand !== filters.brand) return false;
  return true;
};

const mapRowsWithRank = (rows) =>
  rows.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));

const sortByValueDesc = (rows, key = "value") =>
  [...rows].sort((left, right) => Number(right?.[key] || 0) - Number(left?.[key] || 0) || String(left?.label || "").localeCompare(String(right?.label || "")));

const groupCountRows = (records, keyField, valueField = "count") => {
  const totals = new Map();
  records.forEach((record) => {
    const label = normalizeText(record?.[keyField]);
    if (!label) return;
    incrementMap(totals, label, Number(record?.[valueField] || 0));
  });

  return Array.from(totals.entries())
    .map(([label, value]) => ({ label, value }))
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
};

const buildTopModuleRows = (records, key = "count", limit = 9) => {
  const byModule = new Map();

  records.forEach((record) => {
    const moduleLabel = normalizeText(record?.module);
    if (!moduleLabel) return;
    const current = byModule.get(moduleLabel) || {
      label: moduleLabel,
      value: 0,
      brand: record?.brand || "Unknown Brand",
    };
    current.value += Number(record?.[key] || 0);
    if (!current.brand && record?.brand) current.brand = record.brand;
    byModule.set(moduleLabel, current);
  });

  return Array.from(byModule.values())
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((row) => ({
      label: row.label,
      value: Math.round(row.value),
      brand: row.brand,
    }));
};

const buildSlideRetentionRows = (records) => {
  const bySlide = new Map();

  records.forEach((record) => {
    const slideKey = normalizeText(record?.slideKey);
    if (!slideKey) return;
    const productName = normalizeText(record?.product);
    if (!productName || isUnknownProduct(productName)) return;

    const current = bySlide.get(slideKey) || {
      year: record.year,
      month: record.month,
      team: record.team,
      psr: record.psr,
      label: record.slideLabel,
      attachment: record.attachment || record.slideLabel,
      slide: record.slide || record.slideLabel,
      exportName: record.slideExportName || record.slide || record.slideLabel,
      slideNumber: Number(record?.slideNumber || 0) || null,
      totalMinutes: 0,
      elapsedSeconds: 0,
      views: 0,
      brand: record.brand || "Unknown Brand",
      product: productName,
      timeOpenedAt: null,
      timeClosedAt: null,
    };

    const startedAtMs = new Date(record?.startedAt || 0).getTime();
    const endedAtMs = new Date(record?.endedAt || 0).getTime();
    current.totalMinutes += Number(record?.durationMinutes || 0);
    current.elapsedSeconds += Number(
      record?.durationSeconds || Number(record?.durationMinutes || 0) * 60 || Number(record?.durationMs || 0) / 1000 || 0
    );
    current.views += Number(record?.views || 0) || 1;
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      current.timeOpenedAt =
        current.timeOpenedAt && current.timeOpenedAt < startedAtMs ? current.timeOpenedAt : startedAtMs;
    }
    if (Number.isFinite(endedAtMs) && endedAtMs > 0) {
      current.timeClosedAt =
        current.timeClosedAt && current.timeClosedAt > endedAtMs ? current.timeClosedAt : endedAtMs;
    }

    bySlide.set(slideKey, current);
  });

  return Array.from(bySlide.values())
    .map((row) => ({
      year: row.year,
      month: row.month,
      team: row.team,
      psr: row.psr,
      ...row,
      totalMinutes: Number(row.totalMinutes.toFixed(2)),
      elapsedSeconds: Math.round(row.elapsedSeconds),
      averageMinutes: Number((row.views > 0 ? row.totalMinutes / row.views : 0).toFixed(2)),
      timeOpenedAt: row.timeOpenedAt ? new Date(row.timeOpenedAt).toISOString() : "",
      timeClosedAt: row.timeClosedAt ? new Date(row.timeClosedAt).toISOString() : "",
    }))
    .filter((row) => row.totalMinutes > 0)
    .sort((left, right) => right.totalMinutes - left.totalMinutes || left.label.localeCompare(right.label))
    .map((row) => ({
      year: row.year,
      month: row.month,
      team: row.team,
      psr: row.psr,
      label: row.label,
      attachment: row.attachment,
      slide: row.slide,
      exportName: row.exportName,
      slideNumber: row.slideNumber,
      brand: row.brand,
      product: row.product,
      totalMinutes: row.totalMinutes,
      elapsedSeconds: row.elapsedSeconds,
      averageMinutes: row.averageMinutes,
      views: row.views,
      timeOpenedAt: row.timeOpenedAt,
      timeClosedAt: row.timeClosedAt,
    }));
};

const buildSlideActivityExportRows = (records, materialUsageRecords = []) => {
  const usageSessions = buildMaterialUsageSessions(materialUsageRecords);
  const usageLookup = buildMaterialUsageLookup(usageSessions);
  const rows = (Array.isArray(records) ? records : [])
    .map((record, index) => {
      const date = normalizeText(record?.date) || "-";
      const year = normalizeText(record?.year) || "-";
      const month = normalizeText(record?.month) || "-";
      const team = normalizeText(record?.team) || "Unassigned Team";
      const psr = normalizeText(record?.psr) || "Unknown Representative";
      const brand = normalizeText(record?.brand) || "Unknown Brand";
      const productName = normalizeText(record?.product);
      if (!productName || isUnknownProduct(productName)) return null;

      const material = toMaterialName({
        attachment: record?.attachment,
        slide: record?.slideExportName || record?.slideTitle || record?.slideLabel || record?.slide,
        brand,
      });
      const slide = normalizeText(
        record?.slideExportName || record?.slideTitle || record?.slideLabel || record?.slide || `Slide ${Number(record?.slideNumber || 0) || 1}`
      );
      const secondsViewed = Math.max(
        0,
        Math.round(
          Number(record?.durationSeconds || Number(record?.durationMinutes || 0) * 60 || Number(record?.durationMs || 0) / 1000 || 0)
        )
      );
      const startedAtMs = new Date(record?.startedAt || 0).getTime();
      const endedAtMs = new Date(record?.endedAt || 0).getTime();
      const matchedUsage = findMatchingMaterialUsage(usageLookup, {
        date,
        sessionId: record?.sessionId,
        deckId: record?.deckId || record?.caseId || "",
        caseId: record?.caseId || "",
        psr,
        brand,
        productName,
        material,
        startedAtMs,
        endedAtMs,
      });
      const materialSessionKey =
        matchedUsage?.materialUseKey ||
        [
          date,
          normalizeText(record?.sessionId) || psr,
          team,
          brand,
          productName,
          normalizeText(record?.deckId) || normalizeText(record?.caseId) || material,
          material,
        ].join("||");
      const materialOpenedAtMs = Number(
        parseEventTime(matchedUsage?.timeOpenedAt || record?.startedAt)?.getTime() || startedAtMs || endedAtMs || 0
      );
      const materialClosedAtMs = Number(
        parseEventTime(matchedUsage?.timeClosedAt || record?.endedAt)?.getTime() || endedAtMs || startedAtMs || 0
      );

      return {
        date,
        year,
        month,
        team,
        psr,
        brand,
        productName,
        material,
        slide,
        sessionId: normalizeText(record?.sessionId) || normalizeText(matchedUsage?.sessionId),
        materialUseKey: normalizeText(matchedUsage?.materialUseKey),
        materialSessionKey,
        secondsViewed,
        secondsIdle: 0,
        timeSlideOpenedAt: Number.isFinite(startedAtMs) && startedAtMs > 0 ? new Date(startedAtMs).toISOString() : "",
        timeSlideClosedAt: Number.isFinite(endedAtMs) && endedAtMs > 0 ? new Date(endedAtMs).toISOString() : "",
        materialOpenedAtMs,
        materialClosedAtMs,
        slideOpenedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : materialOpenedAtMs,
        slideClosedAtMs: Number.isFinite(endedAtMs) && endedAtMs > 0 ? endedAtMs : materialClosedAtMs,
        sortIndex: index,
      };
    })
    .filter(Boolean);

  const rowsBySession = new Map();
  rows.forEach((row) => {
    const sessionRows = rowsBySession.get(row.materialSessionKey) || [];
    sessionRows.push(row);
    rowsBySession.set(row.materialSessionKey, sessionRows);
  });

  rowsBySession.forEach((sessionRows) => {
    sessionRows.sort(
      (left, right) =>
        Number(left.slideOpenedAtMs || 0) - Number(right.slideOpenedAtMs || 0) ||
        Number(left.slideClosedAtMs || 0) - Number(right.slideClosedAtMs || 0) ||
        Number(left.sortIndex || 0) - Number(right.sortIndex || 0)
    );

    sessionRows.forEach((row, index) => {
      const nextRow = sessionRows[index + 1] || null;
      const idleStart = Number(row.slideClosedAtMs || row.materialClosedAtMs || row.slideOpenedAtMs || 0);
      const idleEnd = nextRow
        ? Number(nextRow.slideOpenedAtMs || nextRow.materialOpenedAtMs || idleStart)
        : Number(row.materialClosedAtMs || idleStart);

      row.secondsIdle = Math.max(0, Math.round((idleEnd - idleStart) / 1000));
    });
  });

  return rows
    .map(({ materialSessionKey, materialOpenedAtMs, materialClosedAtMs, slideOpenedAtMs, slideClosedAtMs, sortIndex, ...row }) => row)
    .sort(
      (left, right) =>
        String(left.date).localeCompare(String(right.date)) ||
        String(left.timeSlideOpenedAt || "").localeCompare(String(right.timeSlideOpenedAt || "")) ||
        String(left.timeSlideClosedAt || "").localeCompare(String(right.timeSlideClosedAt || "")) ||
        String(left.month).localeCompare(String(right.month)) ||
        String(left.team).localeCompare(String(right.team)) ||
        String(left.psr).localeCompare(String(right.psr)) ||
        String(left.brand).localeCompare(String(right.brand)) ||
        String(left.material).localeCompare(String(right.material)) ||
        String(left.slide).localeCompare(String(right.slide))
    );
};

const resolveLegacySlideNumber = (event) => {
  const action = normalizeText(event?.action).toLowerCase();
  const details = event?.details || {};
  const rawValue =
    action === "presentation_slide_view"
      ? details?.slideNumber ?? details?.slideIndex
      : action === "swipe_slide"
      ? details?.toSlide ?? details?.slideNumber ?? details?.slideIndex
      : details?.slideNumber ?? details?.toIndex ?? details?.slideIndex ?? details?.toSlide;
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) return 1;
  if (action === "presentation_slide_view" || action === "swipe_slide") {
    return Math.max(1, Math.round(numericValue));
  }
  return Math.max(1, Math.round(numericValue) + 1);
};

const buildLegacySlideActivityExportRows = (records = []) => {
  const rows = (Array.isArray(records) ? records : [])
    .map((record, index) => {
      const occurredAt = parseEventTime(record?.occurredAt);
      if (!occurredAt) return null;

      const productName = normalizeText(record?.product);
      if (!productName || isUnknownProduct(productName)) return null;

      const brand = normalizeText(record?.brand) || "Unknown Brand";
      const material = normalizeText(record?.material || record?.module) || "UNKNOWN MATERIAL";
      const slideNumber = Math.max(1, Math.round(Number(record?.slideNumber || 1)));
      const slide = normalizeText(record?.slide) || `Slide ${slideNumber}`;

      return {
        date: occurredAt.toISOString().slice(0, 10),
        year: String(occurredAt.getUTCFullYear()),
        month: MONTH_NAMES[occurredAt.getUTCMonth()],
        team: normalizeText(record?.team) || "Unassigned Team",
        psr: normalizeText(record?.psr) || "Unknown Representative",
        brand,
        productName,
        material,
        slide,
        sessionId: normalizeText(record?.sessionId),
        materialUseKey: "",
        materialSessionKey: [
          occurredAt.toISOString().slice(0, 10),
          normalizeText(record?.sessionId) || normalizeText(record?.psr),
          brand,
          productName,
          normalizeText(record?.deckId) || material,
        ].join("||"),
        secondsViewed: 0,
        secondsIdle: 0,
        timeSlideOpenedAt: occurredAt.toISOString(),
        timeSlideClosedAt: occurredAt.toISOString(),
        openedAtMs: occurredAt.getTime(),
        closedAtMs: occurredAt.getTime(),
        sortIndex: index,
      };
    })
    .filter(Boolean);

  const rowsBySession = new Map();
  rows.forEach((row) => {
    const sessionRows = rowsBySession.get(row.materialSessionKey) || [];
    sessionRows.push(row);
    rowsBySession.set(row.materialSessionKey, sessionRows);
  });

  rowsBySession.forEach((sessionRows) => {
    sessionRows.sort(
      (left, right) => Number(left.openedAtMs || 0) - Number(right.openedAtMs || 0) || Number(left.sortIndex || 0) - Number(right.sortIndex || 0)
    );

    sessionRows.forEach((row, index) => {
      const nextRow = sessionRows[index + 1] || null;
      const nextOpenedAtMs = Number(nextRow?.openedAtMs || 0);
      const closedAtMs = nextOpenedAtMs > row.openedAtMs ? nextOpenedAtMs : row.openedAtMs;
      const secondsViewed = Math.max(0, Math.min(1800, Math.round((closedAtMs - row.openedAtMs) / 1000)));

      row.closedAtMs = closedAtMs;
      row.secondsViewed = secondsViewed;
      row.timeSlideClosedAt = new Date(closedAtMs).toISOString();
    });
  });

  return rows
    .map(({ materialSessionKey, openedAtMs, closedAtMs, sortIndex, ...row }) => row)
    .sort(
      (left, right) =>
        String(left.date).localeCompare(String(right.date)) ||
        String(left.timeSlideOpenedAt || "").localeCompare(String(right.timeSlideOpenedAt || "")) ||
        String(left.timeSlideClosedAt || "").localeCompare(String(right.timeSlideClosedAt || "")) ||
        String(left.month).localeCompare(String(right.month)) ||
        String(left.team).localeCompare(String(right.team)) ||
        String(left.psr).localeCompare(String(right.psr)) ||
        String(left.brand).localeCompare(String(right.brand)) ||
        String(left.material).localeCompare(String(right.material)) ||
        String(left.slide).localeCompare(String(right.slide))
    );
};

const buildMaterialOpenRowsFromSlideActivityRows = (rows = []) => {
  const grouped = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const productName = normalizeText(row?.productName || row?.product);
    const material = normalizeText(row?.material);
    if (!productName || !material || isUnknownProduct(productName)) return;

    const key = [
      row?.date || "",
      row?.sessionId || row?.psr || "",
      row?.team || "",
      row?.brand || "",
      productName,
      material,
    ].join("||");
    const openedAt = parseEventTime(row?.timeSlideOpenedAt);
    const closedAt = parseEventTime(row?.timeSlideClosedAt);
    const openedAtMs = openedAt?.getTime() || 0;
    const closedAtMs = closedAt?.getTime() || openedAtMs;
    const current = grouped.get(key) || {
      date: normalizeText(row?.date) || "-",
      year: normalizeText(row?.year) || "-",
      month: normalizeText(row?.month) || "-",
      team: normalizeText(row?.team) || "Unassigned Team",
      psr: normalizeText(row?.psr) || "Unknown Representative",
      brand: normalizeText(row?.brand) || "Unknown Brand",
      productName,
      material,
      sessionId: normalizeText(row?.sessionId),
      deckId: "",
      materialUseKey: "",
      timeOpenedAt: "",
      timeClosedAt: "",
      openedAtMs: 0,
      closedAtMs: 0,
    };

    if (openedAtMs && (!current.openedAtMs || openedAtMs < current.openedAtMs)) {
      current.openedAtMs = openedAtMs;
      current.timeOpenedAt = new Date(openedAtMs).toISOString();
    }
    if (closedAtMs && (!current.closedAtMs || closedAtMs > current.closedAtMs)) {
      current.closedAtMs = closedAtMs;
      current.timeClosedAt = new Date(closedAtMs).toISOString();
    }

    grouped.set(key, current);
  });

  return Array.from(grouped.values())
    .map(({ openedAtMs, closedAtMs, ...row }) => row)
    .sort(
      (left, right) =>
        String(left.date).localeCompare(String(right.date)) ||
        String(left.timeOpenedAt || "").localeCompare(String(right.timeOpenedAt || "")) ||
        String(left.timeClosedAt || "").localeCompare(String(right.timeClosedAt || "")) ||
        String(left.team).localeCompare(String(right.team)) ||
        String(left.psr).localeCompare(String(right.psr)) ||
        String(left.brand).localeCompare(String(right.brand)) ||
        String(left.material).localeCompare(String(right.material))
    );
};

const buildMovingMonthlyModules = (records, limit = 6) => {
  const monthIndices = uniqueSorted(records.map((record) => String(record.monthIndex)))
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);

  const topModules = buildTopModuleRows(records, "count", limit).map((row) => row.label);
  return {
    monthKeys: monthIndices.map((index) => MONTH_KEYS[index] || `M${index + 1}`),
    rows: topModules.map((moduleLabel) => {
      const moduleRecords = records.filter((record) => record.module === moduleLabel);
      const brand = moduleRecords[0]?.brand || "Unknown Brand";
      const values = Object.fromEntries(
        monthIndices.map((monthIndex) => {
          const monthKey = MONTH_KEYS[monthIndex] || `M${monthIndex + 1}`;
          const total = sumValues(
            moduleRecords
              .filter((record) => record.monthIndex === monthIndex)
              .map((record) => record.count)
          );
          return [monthKey, Math.round(total)];
        })
      );

      return {
        label: moduleLabel,
        brand,
        values,
      };
    }),
  };
};

const buildSeriesChart = (records, labelLimit = 7, seriesField = "team", seriesLimit = 6, options = {}) => {
  const includeSeriesLabels = Array.isArray(options?.includeSeriesLabels) ? options.includeSeriesLabels : [];
  const topLabels = buildTopModuleRows(records, "count", labelLimit).map((row) => row.label);
  const sortedSeries = groupCountRows(records, seriesField, "count");
  const limitedSeries = (
    Number.isFinite(seriesLimit) && Number(seriesLimit) > 0
      ? sortedSeries.slice(0, Number(seriesLimit))
      : sortedSeries
  ).map((row) => row.label);
  const topSeries = Array.from(
    new Set(
      [
        ...includeSeriesLabels.map((label) => normalizeText(label)).filter((label) => label && label !== EMPTY_FILTER_VALUE),
        ...limitedSeries,
      ].filter(Boolean)
    )
  );

  return {
    labels: topLabels,
    series: topSeries.map((seriesLabel) => ({
      label: seriesLabel,
      values: topLabels.map((moduleLabel) =>
        Math.round(
          sumValues(
            records
              .filter((record) => record.module === moduleLabel && record[seriesField] === seriesLabel)
              .map((record) => record.count)
          )
        )
      ),
    })),
  };
};

const mapModuleTimeRecordsToMinuteCount = (records) =>
  (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    count: Math.round(Number(record?.durationSeconds || 0) / 60),
  }));

const buildMaterialSummaryGroupPayload = ({
  key,
  label,
  products,
  productGroups,
  monthEventRecords,
  monthModuleTimeRecords,
  periodEventRecords,
}) => {
  const groupedMonthEventRecords = filterRecordsByCurrentProductMaterials(monthEventRecords, products, productGroups, [
    "product",
    "brand",
  ]);
  const groupedMonthModuleTimeRecords = filterRecordsByCurrentProductMaterials(
    monthModuleTimeRecords,
    products,
    productGroups,
    ["brand"]
  );
  const groupedPeriodEventRecords = filterRecordsByCurrentProductMaterials(periodEventRecords, products, productGroups, [
    "product",
    "brand",
  ]);

  return {
    key,
    label,
    generalCountModules: buildTopModuleRows(groupedMonthEventRecords, "count", 9),
    generalTimeModules: buildTopModuleRows(mapModuleTimeRecordsToMinuteCount(groupedMonthModuleTimeRecords), "count", 9),
    brandTotalModules: buildTopModuleRows(groupedMonthEventRecords, "count", 7),
    movingMonthly: buildMovingMonthlyModules(groupedPeriodEventRecords, 7),
  };
};

const buildSpecialtyCharts = (records) => {
  const toGenericKey = (value) => normalizeText(value).toLowerCase();
  const genericLabels = new Set(["uncategorized", "unknown brand", "-", "all divisions", "all brands"]);
  const toCharts = (field) =>
    groupCountRows(records, field, "count").map((row) => ({
      title: row.label,
      sourceField: field,
      modules: buildTopModuleRows(
        records.filter((record) => record[field] === row.label),
        "count",
        7
      ),
    }));

  const preferredDivisionCharts = toCharts("division").filter(
    (chart) => !genericLabels.has(toGenericKey(chart.title))
  );
  const genericDivisionCharts = toCharts("division").filter((chart) =>
    genericLabels.has(toGenericKey(chart.title))
  );
  const preferredBrandCharts = toCharts("brand").filter(
    (chart) => !genericLabels.has(toGenericKey(chart.title))
  );
  const genericBrandCharts = toCharts("brand").filter((chart) =>
    genericLabels.has(toGenericKey(chart.title))
  );

  const result = [];
  const seenTitles = new Set();

  const appendCharts = (charts) => {
    charts.forEach((chart) => {
      if (result.length >= 2) return;
      const dedupeKey = `${chart.sourceField}:${chart.title}`;
      if (seenTitles.has(dedupeKey)) return;
      if (!Array.isArray(chart.modules) || chart.modules.length === 0) return;
      seenTitles.add(dedupeKey);
      result.push(chart);
    });
  };

  appendCharts(preferredDivisionCharts);
  appendCharts(preferredBrandCharts);
  appendCharts(genericDivisionCharts);
  appendCharts(genericBrandCharts);

  return result.slice(0, 2).map(({ sourceField, ...chart }) => chart);
};

const buildRankingRows = (records, groupKeys, limit = 10) => {
  const totals = new Map();

  records.forEach((record) => {
    const compositeKey = groupKeys.map((key) => normalizeText(record?.[key]) || "-").join("||");
    const current = totals.get(compositeKey) || Object.fromEntries(groupKeys.map((key) => [key, record?.[key] || "-"]));
    current.detailingCount = (current.detailingCount || 0) + Number(record?.count || 0);
    totals.set(compositeKey, current);
  });

  return Array.from(totals.values())
    .filter((row) => Number(row.detailingCount || 0) > 0)
    .sort(
      (left, right) =>
        Number(right.detailingCount || 0) - Number(left.detailingCount || 0) ||
        String(left[groupKeys[0]] || "").localeCompare(String(right[groupKeys[0]] || ""))
    )
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
};

const toMonthValue = (month) => {
  const monthIndex = MONTH_NAMES.findIndex((entry) => entry.toLowerCase() === normalizeText(month).toLowerCase());
  return monthIndex >= 0 ? monthIndex : null;
};

const normalizeFilterValue = (value, options, fallback) => {
  const normalized = normalizeText(value);
  if (normalized && options.includes(normalized)) return normalized;
  return fallback;
};

const buildTotalRows = (records, keyField, limit = 10, { includeBrandMetadata = false } = {}) => {
  const totals = new Map();

  records.forEach((record) => {
    const label = normalizeText(record?.[keyField]);
    if (!label) return;

    const current = totals.get(label) || {
      label,
      value: 0,
      brand: "",
      product: "",
      productGroupLabel: "",
    };

    current.value += Number(record?.count || 0);

    if (includeBrandMetadata) {
      if (!current.brand && record?.brand) current.brand = normalizeText(record.brand);
      if (!current.product && record?.product) current.product = normalizeText(record.product);
      if (!current.productGroupLabel && record?.productGroupLabel) current.productGroupLabel = normalizeText(record.productGroupLabel);
    }

    totals.set(label, current);
  });

  return Array.from(totals.values())
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((row) => ({
      label: row.label,
      value: Math.round(row.value),
      ...(includeBrandMetadata
        ? {
            brand: row.brand,
            product: row.product,
            productGroupLabel: row.productGroupLabel,
          }
        : {}),
    }));
};

const buildProductTotalRows = (records, products, { limit = null } = {}) => {
  const totals = new Map();

  (Array.isArray(products) ? products : []).forEach((product) => {
    const label = normalizeText(product?.name);
    if (!label || isUnknownProduct(label)) return;

    totals.set(label, {
      label,
      value: 0,
      brand: getBrandLabel(product),
      product: label,
      productGroupLabel: "",
    });
  });

  (Array.isArray(records) ? records : []).forEach((record) => {
    const label = normalizeText(record?.product);
    if (!label || isUnknownProduct(label)) return;

    const current = totals.get(label) || {
      label,
      value: 0,
      brand: "",
      product: label,
      productGroupLabel: "",
    };

    current.value += Number(record?.count || 0);
    if (!current.brand && record?.brand) current.brand = normalizeText(record.brand);
    if (!current.productGroupLabel && record?.productGroupLabel) current.productGroupLabel = normalizeText(record.productGroupLabel);

    totals.set(label, current);
  });

  let rows = Array.from(totals.values()).sort(
    (left, right) => Number(right.value || 0) - Number(left.value || 0) || left.label.localeCompare(right.label)
  );

  if (Number.isInteger(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }

  return rows.map((row) => ({
    label: row.label,
    value: Math.round(row.value),
    brand: row.brand,
    product: row.product,
    productGroupLabel: row.productGroupLabel,
  }));
};

const matchesScopedValue = (value, selectedValue) =>
  selectedValue === EMPTY_FILTER_VALUE || normalizeText(value) === normalizeText(selectedValue);

const buildFilterRelationships = (users, records) => {
  const relationships = [];
  const seen = new Set();

  const appendRelationship = (division, team, psr) => {
    const normalizedDivision = normalizeText(division);
    const normalizedTeam = normalizeText(team);
    const normalizedRepresentative = normalizeText(psr);

    if (!normalizedDivision || !normalizedTeam || !normalizedRepresentative) return;
    if (isUnassignedTeam(normalizedTeam) || isUnknownRepresentative(normalizedRepresentative)) return;

    const key = [normalizedDivision, normalizedTeam, normalizedRepresentative].map(normalizeComparableText).join("||");
    if (seen.has(key)) return;

    seen.add(key);
    relationships.push({
      division: normalizedDivision,
      team: normalizedTeam,
      psr: normalizedRepresentative,
    });
  };

  (Array.isArray(users) ? users : []).forEach((user) => {
    appendRelationship(getDivisionLabel(user), getTeamLabel(user), getRepLabel(user));
  });

  (Array.isArray(records) ? records : []).forEach((record) => {
    appendRelationship(record?.division, record?.team, record?.psr);
  });

  return relationships.sort(
    (left, right) =>
      left.division.localeCompare(right.division) ||
      left.team.localeCompare(right.team) ||
      left.psr.localeCompare(right.psr)
  );
};

const buildDivisionOptionsFromRelationships = (relationships, filters = {}) => [
  EMPTY_FILTER_VALUE,
  ...uniqueSorted(
    (Array.isArray(relationships) ? relationships : [])
      .filter((relationship) => matchesScopedValue(relationship.team, filters.team || EMPTY_FILTER_VALUE))
      .filter((relationship) => matchesScopedValue(relationship.psr, filters.psr || EMPTY_FILTER_VALUE))
      .map((relationship) => relationship.division)
  ),
];

const buildTeamOptionsFromRelationships = (relationships, filters = {}) => [
  EMPTY_FILTER_VALUE,
  ...uniqueSorted(
    (Array.isArray(relationships) ? relationships : [])
      .filter((relationship) => matchesScopedValue(relationship.division, filters.division || EMPTY_FILTER_VALUE))
      .filter((relationship) => matchesScopedValue(relationship.psr, filters.psr || EMPTY_FILTER_VALUE))
      .map((relationship) => relationship.team)
  ),
];

const buildRepresentativeOptionsFromRelationships = (relationships, filters = {}) => [
  EMPTY_FILTER_VALUE,
  ...uniqueSorted(
    (Array.isArray(relationships) ? relationships : [])
      .filter((relationship) => matchesScopedValue(relationship.division, filters.division || EMPTY_FILTER_VALUE))
      .filter((relationship) => matchesScopedValue(relationship.team, filters.team || EMPTY_FILTER_VALUE))
      .map((relationship) => relationship.psr)
  ),
];

const resolveScopedEntityFilters = (relationships, inputFilters = {}) => {
  const baseDivisionOptions = buildDivisionOptionsFromRelationships(relationships);
  const baseTeamOptions = buildTeamOptionsFromRelationships(relationships);
  const basePsrOptions = buildRepresentativeOptionsFromRelationships(relationships);

  const requestedDivision = normalizeFilterValue(inputFilters.division, baseDivisionOptions, EMPTY_FILTER_VALUE);
  const requestedTeam = normalizeFilterValue(inputFilters.team, baseTeamOptions, EMPTY_FILTER_VALUE);
  const requestedPsr = normalizeFilterValue(inputFilters.psr, basePsrOptions, EMPTY_FILTER_VALUE);

  let selectedDivision = requestedDivision;
  let selectedTeam = requestedTeam;
  let selectedPsr = requestedPsr;
  let divisionOptions = baseDivisionOptions;
  let teamOptions = baseTeamOptions;
  let psrOptions = basePsrOptions;

  if (selectedPsr !== EMPTY_FILTER_VALUE) {
    const representativeRelationships = (Array.isArray(relationships) ? relationships : []).filter(
      (relationship) => relationship.psr === selectedPsr
    );
    const representativeDivisionOptions = buildDivisionOptionsFromRelationships(representativeRelationships);
    const representativeTeamOptions = buildTeamOptionsFromRelationships(representativeRelationships);
    const representativeDivisions = representativeDivisionOptions.filter((option) => option !== EMPTY_FILTER_VALUE);
    const representativeTeams = representativeTeamOptions.filter((option) => option !== EMPTY_FILTER_VALUE);

    selectedDivision =
      representativeDivisions.length === 1
        ? representativeDivisions[0]
        : normalizeFilterValue(requestedDivision, representativeDivisionOptions, EMPTY_FILTER_VALUE);
    selectedTeam =
      representativeTeams.length === 1
        ? representativeTeams[0]
        : normalizeFilterValue(requestedTeam, representativeTeamOptions, EMPTY_FILTER_VALUE);

    divisionOptions = buildDivisionOptionsFromRelationships(relationships, {
      team: selectedTeam,
      psr: selectedPsr,
    });
    selectedDivision = normalizeFilterValue(selectedDivision, divisionOptions, EMPTY_FILTER_VALUE);

    teamOptions = buildTeamOptionsFromRelationships(relationships, {
      division: selectedDivision,
      psr: selectedPsr,
    });
    selectedTeam = normalizeFilterValue(selectedTeam, teamOptions, EMPTY_FILTER_VALUE);
  } else {
    divisionOptions = buildDivisionOptionsFromRelationships(relationships, {
      team: selectedTeam,
    });
    selectedDivision = normalizeFilterValue(selectedDivision, divisionOptions, EMPTY_FILTER_VALUE);

    teamOptions = buildTeamOptionsFromRelationships(relationships, {
      division: selectedDivision,
    });
    selectedTeam = normalizeFilterValue(selectedTeam, teamOptions, EMPTY_FILTER_VALUE);

    divisionOptions = buildDivisionOptionsFromRelationships(relationships, {
      team: selectedTeam,
    });
    selectedDivision = normalizeFilterValue(selectedDivision, divisionOptions, EMPTY_FILTER_VALUE);

    teamOptions = buildTeamOptionsFromRelationships(relationships, {
      division: selectedDivision,
    });
    selectedTeam = normalizeFilterValue(selectedTeam, teamOptions, EMPTY_FILTER_VALUE);
  }

  psrOptions = buildRepresentativeOptionsFromRelationships(relationships, {
    division: selectedDivision,
    team: selectedTeam,
  });
  selectedPsr = normalizeFilterValue(selectedPsr, psrOptions, EMPTY_FILTER_VALUE);

  divisionOptions = buildDivisionOptionsFromRelationships(relationships, {
    team: selectedTeam,
    psr: selectedPsr,
  });
  selectedDivision = normalizeFilterValue(selectedDivision, divisionOptions, EMPTY_FILTER_VALUE);

  teamOptions = buildTeamOptionsFromRelationships(relationships, {
    division: selectedDivision,
    psr: selectedPsr,
  });
  selectedTeam = normalizeFilterValue(selectedTeam, teamOptions, EMPTY_FILTER_VALUE);

  psrOptions = buildRepresentativeOptionsFromRelationships(relationships, {
    division: selectedDivision,
    team: selectedTeam,
  });
  selectedPsr = normalizeFilterValue(selectedPsr, psrOptions, EMPTY_FILTER_VALUE);

  return {
    divisionOptions,
    teamOptions,
    psrOptions,
    selectedDivision,
    selectedTeam,
    selectedPsr,
  };
};

const TD_PRODUCT_GROUPS = [
  { label: "Meptin", aliases: ["MEPTIN"] },
  { label: "Mucosta", aliases: ["MUCOSTA"] },
  { label: "Pletaal", aliases: ["PLETAAL", "PLETAA"] },
  { label: "Aminoleban Oral", aliases: ["AMINOLEBAN ORAL", "AMINOLEBAN"] },
  { label: "Samsca", aliases: ["SAMSCA"] },
  { label: "Jinarc", aliases: ["JINARC"] },
];

const CNS_PRODUCT_GROUPS = [
  { label: "Abilify Maintena", aliases: ["ABILIFY MAINTENA", "ABILIFY MAINTENA®", "MAINTENA"] },
  { label: "Rexulti", aliases: ["REXULTI"] },
];

const REXULTI_PRODUCT_GROUPS = CNS_PRODUCT_GROUPS.filter((group) => group.label === "Rexulti");
const ABILIFY_MAINTENA_PRODUCT_GROUPS = CNS_PRODUCT_GROUPS.filter((group) => group.label === "Abilify Maintena");
const MATERIAL_SUMMARY_GROUPS = [
  { key: "td", label: "TD Product", productGroups: TD_PRODUCT_GROUPS },
  { key: "rexulti", label: "Rexulti", productGroups: REXULTI_PRODUCT_GROUPS },
  { key: "abilifyMaintena", label: "Abilify Maintena", productGroups: ABILIFY_MAINTENA_PRODUCT_GROUPS },
];

const LEGACY_BRAND_SHARE_LABELS = [...TD_PRODUCT_GROUPS, ...CNS_PRODUCT_GROUPS].map((group) => group.label);

const buildProductGroupAliasEntries = (productGroups = []) =>
  productGroups.flatMap((group) =>
    (Array.isArray(group.aliases) ? group.aliases : [group.label]).map((alias) => ({
      canonicalLabel: group.label,
      alias: normalizeComparableText(alias),
    }))
  );

const findMatchingProductGroup = (value, aliasEntries = []) => {
  const label = normalizeComparableText(value);
  if (!label) return null;

  return (
    aliasEntries.find((entry) => label === entry.alias || label.includes(entry.alias) || entry.alias.includes(label)) || null
  );
};

const LEGACY_BRAND_SHARE_ALIAS_ENTRIES = buildProductGroupAliasEntries([
  ...TD_PRODUCT_GROUPS,
  ...CNS_PRODUCT_GROUPS,
]);

const toLegacyBrandShareLabel = (value) =>
  findMatchingProductGroup(value, LEGACY_BRAND_SHARE_ALIAS_ENTRIES)?.canonicalLabel || normalizeText(value);

const buildPercentRowsFromProductGroups = (
  records,
  keyField,
  productGroups,
  valueField = "count",
  { includeZeroRows = false } = {}
) => {
  const totals = new Map(productGroups.map((group) => [group.label, 0]));
  const aliasEntries = buildProductGroupAliasEntries(productGroups);

  records.forEach((record) => {
    const matchedAlias = findMatchingProductGroup(record?.[keyField], aliasEntries);
    if (!matchedAlias) return;

    incrementMap(totals, matchedAlias.canonicalLabel, Number(record?.[valueField] || 0));
  });

  const total = sumValues(Array.from(totals.values()));
  return Array.from(totals.entries())
    .map(([label, value]) => ({
      label,
      brand: label,
      productGroupLabel: label,
      rawValue: Math.round(value),
      value: total > 0 ? Number(((Number(value || 0) / total) * 100).toFixed(1)) : 0,
    }))
    .filter((row) => includeZeroRows || row.rawValue > 0)
    .sort((left, right) => right.rawValue - left.rawValue || left.label.localeCompare(right.label));
};

const filterRecordsByProductGroups = (records, productGroups, candidateFields = ["product", "brand"]) => {
  const aliasEntries = buildProductGroupAliasEntries(productGroups);
  if (!aliasEntries.length) return [];

  return (Array.isArray(records) ? records : []).filter((record) =>
    candidateFields.some((field) => findMatchingProductGroup(record?.[field], aliasEntries))
  );
};

const buildMaterialDefinitionsForProductGroups = (products, productGroups) => {
  const aliasEntries = buildProductGroupAliasEntries(productGroups);
  const materialDefinitions = [];
  const materialDefinitionByKey = new Map();
  const productList = Array.isArray(products) ? products : [];

  productList.forEach((product) => {
    const matchedProductGroup =
      findMatchingProductGroup(product?.name, aliasEntries) ||
      findMatchingProductGroup(product?.brandName, aliasEntries) ||
      findMatchingProductGroup(product?.category, aliasEntries);
    if (!matchedProductGroup) return;

    (Array.isArray(product?.media) ? product.media : []).forEach((media) => {
      const canonicalLabel = cleanModuleLabel(media?.groupTitle || media?.sourceName || media?.title);
      if (!canonicalLabel) return;

      const definitionKey = `${matchedProductGroup.canonicalLabel}::${normalizeLookupKey(canonicalLabel)}`;
      const current = materialDefinitionByKey.get(definitionKey) || {
        productGroupLabel: matchedProductGroup.canonicalLabel,
        label: canonicalLabel,
        aliases: new Set(),
      };

      [canonicalLabel, media?.groupTitle, media?.sourceName, media?.title, media?.groupId]
        .map((value) => normalizeLookupKey(value))
        .filter(Boolean)
        .forEach((alias) => current.aliases.add(alias));

      if (!materialDefinitionByKey.has(definitionKey)) {
        materialDefinitionByKey.set(definitionKey, current);
        materialDefinitions.push(current);
      }
    });
  });

  return materialDefinitions;
};

const findMatchingMaterialDefinition = (
  materialDefinitions,
  productGroupLabel,
  materialValue,
  productGroupAliasEntries = []
) => {
  const materialKey = normalizeLookupKey(materialValue);
  if (!materialKey) return null;

  const exactMatch = materialDefinitions.find((definition) => {
    if (definition.productGroupLabel !== productGroupLabel) return false;
    return Array.from(definition.aliases).some((alias) => materialKey === alias);
  });
  if (exactMatch) return exactMatch;

  const productGroupAliasKeys = productGroupAliasEntries
    .filter((entry) => entry.canonicalLabel === productGroupLabel)
    .map((entry) => normalizeLookupKey(entry.alias))
    .filter(Boolean);
  if (productGroupAliasKeys.includes(materialKey)) return null;

  return (
    materialDefinitions.find((definition) => {
      if (definition.productGroupLabel !== productGroupLabel) return false;

      return Array.from(definition.aliases).some(
        (alias) => materialKey === alias || materialKey.includes(alias) || alias.includes(materialKey)
      );
    }) || null
  );
};

const filterRecordsByCurrentProductMaterials = (
  records,
  products,
  productGroups,
  candidateFields = ["product", "brand"]
) => {
  const aliasEntries = buildProductGroupAliasEntries(productGroups);
  const materialDefinitions = buildMaterialDefinitionsForProductGroups(products, productGroups);
  if (!aliasEntries.length) return [];
  if (!materialDefinitions.length) return filterRecordsByProductGroups(records, productGroups, candidateFields);

  return (Array.isArray(records) ? records : []).reduce((filteredRecords, record) => {
    const matchedProductGroup = candidateFields.reduce(
      (match, field) => match || findMatchingProductGroup(record?.[field], aliasEntries),
      null
    );
    if (!matchedProductGroup) return filteredRecords;

    const matchedMaterial = findMatchingMaterialDefinition(
      materialDefinitions,
      matchedProductGroup.canonicalLabel,
      record?.module,
      aliasEntries
    );
    if (!matchedMaterial) return filteredRecords;

    filteredRecords.push({
      ...record,
      module: matchedMaterial.label,
    });
    return filteredRecords;
  }, []);
};

const buildMaterialShareRowsForProductGroups = (
  records,
  products,
  productGroups,
  {
    productField = "product",
    materialField = "module",
    valueField = "count",
    includeZeroRows = true,
  } = {}
) => {
  const aliasEntries = buildProductGroupAliasEntries(productGroups);
  const materialGroups = [];
  const materialGroupByKey = new Map();
  const productList = Array.isArray(products) ? products : [];

  productList.forEach((product) => {
    const matchedProductGroup =
      findMatchingProductGroup(product?.name, aliasEntries) ||
      findMatchingProductGroup(product?.brandName, aliasEntries) ||
      findMatchingProductGroup(product?.category, aliasEntries);
    if (!matchedProductGroup) return;

    (Array.isArray(product?.media) ? product.media : []).forEach((media) => {
      const canonicalLabel = cleanModuleLabel(media?.groupTitle || media?.sourceName || media?.title);
      if (!canonicalLabel) return;

      const groupKey = `${matchedProductGroup.canonicalLabel}::${normalizeLookupKey(canonicalLabel)}`;
      const current = materialGroupByKey.get(groupKey) || {
        productGroupLabel: matchedProductGroup.canonicalLabel,
        label: canonicalLabel,
        aliases: new Set(),
      };

      [media?.groupTitle, media?.sourceName, media?.title]
        .map((value) => normalizeLookupKey(value))
        .filter(Boolean)
        .forEach((alias) => current.aliases.add(alias));

      current.aliases.add(normalizeLookupKey(canonicalLabel));

      if (!materialGroupByKey.has(groupKey)) {
        materialGroupByKey.set(groupKey, current);
        materialGroups.push(current);
      }
    });
  });

  if (!materialGroups.length) return [];

  const totals = new Map(materialGroups.map((group) => [group.label, 0]));
  const matchedMaterialByLabel = new Map(materialGroups.map((group) => [group.label, group]));

  records.forEach((record) => {
    const matchedProductGroup = findMatchingProductGroup(record?.[productField], aliasEntries);
    if (!matchedProductGroup) return;

    const materialKey = normalizeLookupKey(record?.[materialField]);
    if (!materialKey) return;

    const matchedMaterial = materialGroups.find((group) => {
      if (group.productGroupLabel !== matchedProductGroup.canonicalLabel) return false;
      return Array.from(group.aliases).some(
        (alias) => materialKey === alias || materialKey.includes(alias) || alias.includes(materialKey)
      );
    });
    if (!matchedMaterial) return;

    incrementMap(totals, matchedMaterial.label, Number(record?.[valueField] || 0));
  });

  const total = sumValues(Array.from(totals.values()));
  return Array.from(totals.entries())
    .map(([label, value]) => ({
      label,
      brand: matchedMaterialByLabel.get(label)?.productGroupLabel || "",
      productGroupLabel: matchedMaterialByLabel.get(label)?.productGroupLabel || "",
      rawValue: Math.round(value),
      value: total > 0 ? Number(((Number(value || 0) / total) * 100).toFixed(1)) : 0,
    }))
    .filter((row) => includeZeroRows || row.rawValue > 0)
    .sort((left, right) => right.rawValue - left.rawValue || left.label.localeCompare(right.label));
};

const buildSlideMetricRows = (records, mode = "total", limit = 12) => {
  const grouped = new Map();

  records.forEach((record) => {
    const product = normalizeText(record?.product);
    if (!product || isUnknownProduct(product)) return;

    const slideNumber = Number.isFinite(Number(record?.slideNumber)) ? Math.max(1, Math.round(Number(record.slideNumber))) : 0;
    const rawSlideName = cleanSlideDisplayName(record?.slideTitle || record?.slideLabel || record?.slide);
    const exportSlideName = cleanSlideDisplayName(record?.slideExportName);
    const isGenericSlideName = !rawSlideName || /^slide\s+\d+$/i.test(rawSlideName);
    const slideName = isGenericSlideName ? exportSlideName : rawSlideName;
    const slideLabel = slideName || (slideNumber > 0 ? `Slide ${slideNumber}` : "Unknown Slide");
    const materialName = toMaterialName({
      attachment: record?.attachment,
      slide: record?.slideExportName || record?.slideLabel || record?.slide,
      brand: record?.brand,
    });
    const slideFilename =
      getFilenameFromUrl(record?.slideExportName || "") ||
      normalizeText(record?.slideExportName) ||
      getFilenameFromUrl(record?.slide) ||
      normalizeText(record?.slide) ||
      slideLabel;
    const key = normalizeText(record?.slideKey) || `${product}||${slideNumber || slideLabel}`;
    const current = grouped.get(key) || {
      label: slideLabel,
      materialName,
      slideFilename,
      slideNumber,
      brand: normalizeText(record?.brand) || "",
      product: product,
      totalMinutes: 0,
      views: 0,
    };

    current.totalMinutes += Number(
      record?.durationMinutes || Number(record?.durationSeconds || 0) / 60 || Number(record?.durationMs || 0) / 60000 || 0
    );
    current.views += Number(record?.views || 0) || 1;
    grouped.set(key, current);
  });

  return Array.from(grouped.values())
    .map((row) => ({
      label: row.label,
      materialName: row.materialName,
      slideFilename: row.slideFilename,
      slideNumber:
        Number.isFinite(Number(row.slideNumber)) && Number(row.slideNumber) > 0 ? Math.round(Number(row.slideNumber)) : null,
      brand: row.brand,
      product: row.product,
      slideDetailLabel:
        Number.isFinite(Number(row.slideNumber)) && Number(row.slideNumber) > 0
          ? `${row.slideFilename} - Slide ${Math.round(Number(row.slideNumber))}`
          : row.slideFilename,
      fullLabel:
        Number.isFinite(Number(row.slideNumber)) && Number(row.slideNumber) > 0
          ? `${row.materialName} - Slide ${Math.round(Number(row.slideNumber))}`
          : row.label,
      value:
        mode === "average"
          ? Number((row.views > 0 ? row.totalMinutes / row.views : 0).toFixed(2))
          : Number(row.totalMinutes.toFixed(2)),
    }))
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit);
};

async function buildDashboardReportSource(inputFilters = {}, options = {}) {
  await connectDB();
  const reportCutoff = new Date();
  const reportCutoffTime = reportCutoff.getTime();
  const exportOnly = options?.section === "exports";
  const includeDashboardMetrics = !exportOnly;

  const [products, users, yearRows, retentionYearRows] = await Promise.all([
    Product.find({}).select("name brandName category media.url media.groupId media.sourceName media.groupTitle media.title").lean(),
    User.find({}).select("name username repId role division accessType").lean(),
    ActivityLog.aggregate([
      {
        $match: {
          startedAt: { $lte: reportCutoff },
        },
      },
      {
        $group: {
          _id: {
            $year: "$startedAt",
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    SlideRetention.aggregate([
      {
        $match: {
          endedAt: { $lte: reportCutoff },
        },
      },
      {
        $group: {
          _id: {
            $year: "$endedAt",
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const productById = new Map(products.map((product) => [String(product._id), product]));
  const productLookup = buildProductLookup(products);
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const reportUsers = users.filter((user) => !isUsageExcludedUser(user));
  const attachmentLabelCache = new Map();
  const slideExportNameCache = new Map();
  const buildMediaResolutionCacheKey = (product, record = {}, includeSlide = false) =>
    [
      String(product?._id || product?.name || ""),
      record?.deckTitle,
      record?.presentationTitle,
      record?.caseName,
      record?.sourceName,
      record?.groupTitle,
      record?.title,
      record?.groupId,
      record?.deckId,
      record?.caseId,
      includeSlide ? record?.slideNumber : "",
      includeSlide ? record?.slideIndex : "",
      includeSlide ? record?.slideTitle : "",
    ]
      .map((value) => normalizeText(value))
      .join("||");
  const getCachedCanonicalMediaLabel = (product, record = {}) => {
    const cacheKey = buildMediaResolutionCacheKey(product, record, false);
    if (attachmentLabelCache.has(cacheKey)) return attachmentLabelCache.get(cacheKey);
    const label = resolveCanonicalMediaLabel(product, record);
    attachmentLabelCache.set(cacheKey, label);
    return label;
  };
  const getCachedRetentionSlideExportName = (record = {}, product) => {
    const cacheKey = buildMediaResolutionCacheKey(product, record, true);
    if (slideExportNameCache.has(cacheKey)) return slideExportNameCache.get(cacheKey);
    const label = resolveRetentionSlideExportName(record, product);
    slideExportNameCache.set(cacheKey, label);
    return label;
  };

  const availableYearOptions = uniqueSorted(
    [...yearRows, ...retentionYearRows].map((row) => String(row?._id || ""))
  );
  const yearOptions = [EMPTY_FILTER_VALUE, ...availableYearOptions];
  const fallbackYear = EMPTY_FILTER_VALUE;
  const selectedYear = normalizeFilterValue(inputFilters.year, yearOptions, fallbackYear);

  const logMatch = {
    startedAt: { $lte: reportCutoff },
  };
  if (selectedYear !== EMPTY_FILTER_VALUE) {
    const yearStart = new Date(Date.UTC(Number(selectedYear), 0, 1, 0, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(Number(selectedYear) + 1, 0, 1, 0, 0, 0, 0));
    logMatch.startedAt.$gte = yearStart;
    logMatch.startedAt.$lt = yearEnd;
  }

  const retentionMatch = {
    endedAt: { $lte: reportCutoff },
  };
  if (selectedYear !== EMPTY_FILTER_VALUE) {
    const yearStart = new Date(Date.UTC(Number(selectedYear), 0, 1, 0, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(Number(selectedYear) + 1, 0, 1, 0, 0, 0, 0));
    retentionMatch.endedAt.$gte = yearStart;
    retentionMatch.endedAt.$lt = yearEnd;
  }

  const [logs, slideRetentionRows] = await Promise.all([
    ActivityLog.find(logMatch)
      .select("userId sessionId startedAt endedAt lastOccurredAt events.action events.screen events.deckTitle events.details events.occurredAt")
      .lean(),
    SlideRetention.find(retentionMatch)
      .select("userId sessionId presentationId caseId deckId presentationTitle deckTitle slideId slideIndex slideNumber slideTitle slideType startedAt endedAt durationMs durationSeconds durationMinutes details")
      .lean(),
  ]);

  const monthIndicesWithData = uniqueSorted(
    [
      ...logs.map((log) => {
        const startedAt = new Date(log?.startedAt || 0);
        return Number.isNaN(startedAt.getTime()) || isDateAfterCutoff(startedAt, reportCutoffTime)
          ? ""
          : String(startedAt.getUTCMonth());
      }),
      ...slideRetentionRows.map((row) => {
        const endedAt = new Date(row?.endedAt || 0);
        return Number.isNaN(endedAt.getTime()) || isDateAfterCutoff(endedAt, reportCutoffTime)
          ? ""
          : String(endedAt.getUTCMonth());
      }),
    ]
  )
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);

  const availableMonthOptions = monthIndicesWithData.map((index) => MONTH_NAMES[index]).filter(Boolean);
  const monthOptions = [EMPTY_FILTER_VALUE, ...availableMonthOptions];
  const fallbackMonth = EMPTY_FILTER_VALUE;
  const selectedMonth = normalizeFilterValue(inputFilters.month, monthOptions, fallbackMonth);
  const selectedMonthIndex = toMonthValue(selectedMonth);

  const yearEventRecords = [];
  const yearModuleTimeRecords = [];
  const yearBrandTimeRecords = [];
  const yearMaterialUsageRecords = [];
  const yearSlideRetentionRecords = [];
  const yearLegacySlideActivityExportRecords = [];
  let includedLogCount = 0;

  logs.forEach((log) => {
    const startedAt = new Date(log?.startedAt || 0);
    if (Number.isNaN(startedAt.getTime()) || isDateAfterCutoff(startedAt, reportCutoffTime)) return;

    const user = userById.get(String(log?.userId || ""));
    if (isUsageExcludedUser(user)) return;

    includedLogCount += 1;
    const team = getTeamLabel(user);
    const psr = getRepLabel(user);
    const sessionId = normalizeText(log?.sessionId) || String(log?._id || "");
    const sessionDurationSeconds = includeDashboardMetrics
      ? Math.max(
          30,
          Math.round(
            Math.max(
              0,
              (new Date(log?.endedAt || log?.lastOccurredAt || log?.startedAt || 0).getTime() - startedAt.getTime()) / 1000
            )
          )
        )
      : 0;

    const sessionBrandDurations = includeDashboardMetrics ? new Map() : null;
    const sessionModuleDurations = includeDashboardMetrics ? new Map() : null;
    const sessionMaterialUsage = new Map();

    const rawEvents = Array.isArray(log?.events) ? log.events : [];
    const resolvedProducts = rawEvents.map((event) => resolveEventProduct(event, productById, productLookup));
    const nextResolvedProducts = new Array(rawEvents.length).fill(null);
    let nextResolvedProduct = null;

    for (let index = rawEvents.length - 1; index >= 0; index -= 1) {
      if (resolvedProducts[index]) nextResolvedProduct = resolvedProducts[index];
      nextResolvedProducts[index] = nextResolvedProduct;
    }

    let lastResolvedProduct = null;
    rawEvents.forEach((event, eventIndex) => {
      if (!isMeaningfulEvent(event)) return;

      const occurredAt = new Date(event?.occurredAt || startedAt);
      if (Number.isNaN(occurredAt.getTime()) || isDateAfterCutoff(occurredAt, reportCutoffTime)) return;

      const details = event?.details || {};
      const product = resolvedProducts[eventIndex] || lastResolvedProduct || nextResolvedProducts[eventIndex] || null;
      if (product) lastResolvedProduct = product;
      const productName = normalizeText(product?.name);
      if (!productName || isUnknownProduct(productName)) return;

      const brand = getBrandLabel(product, details);
      const division = getDivisionLabel(user);
      const moduleLabel = getModuleLabel(event, product, brand);
      const materialLabel = getMaterialLabel(event, product, brand);
      const materialUseKey = normalizeText(details?.materialUseKey);
      const deckId = normalizeText(details?.deckId || details?.caseId || details?.presentationId);
      const isLegacySlideEvent = isLegacySlideActivityEvent(event);
      const slideNumber = isLegacySlideEvent ? resolveLegacySlideNumber(event) : 1;
      const slideExportName = isLegacySlideEvent
        ? getCachedRetentionSlideExportName(
            {
              deckTitle: event?.deckTitle || details?.deckTitle,
              presentationTitle: details?.presentationTitle,
              caseName: details?.caseName,
              sourceName: details?.sourceName,
              groupTitle: details?.groupTitle,
              title: details?.title,
              deckId,
              caseId: details?.caseId,
              slideNumber,
              slideIndex: Math.max(0, slideNumber - 1),
              slideTitle: details?.slideTitle,
            },
            product
          )
        : "";

      if (materialUseKey && (isMaterialOpenedEvent(event) || isMaterialClosedEvent(event))) {
        const currentUsage = sessionMaterialUsage.get(materialUseKey) || {
          date: occurredAt.toISOString().slice(0, 10),
          year: String(occurredAt.getUTCFullYear()),
          month: MONTH_NAMES[occurredAt.getUTCMonth()],
          monthIndex: occurredAt.getUTCMonth(),
          sessionId,
          division,
          team,
          psr,
          brand,
          productName,
          deckId,
          material: materialLabel,
          materialUseKey,
          timeOpenedAt: null,
          timeClosedAt: null,
        };

        const openedAt = parseEventTime(details?.timeOpenedAt || details?.materialOpenedAt, occurredAt);
        const closedAt = parseEventTime(details?.timeClosedAt || details?.materialClosedAt, occurredAt);

        if (isMaterialOpenedEvent(event)) {
          const openedAtMs = openedAt?.getTime() || occurredAt.getTime();
          if (!currentUsage.timeOpenedAt || openedAtMs < currentUsage.timeOpenedAt) {
            currentUsage.timeOpenedAt = openedAtMs;
          }
        }

        if (isMaterialClosedEvent(event)) {
          const closedAtMs = closedAt?.getTime() || occurredAt.getTime();
          if (!currentUsage.timeClosedAt || closedAtMs > currentUsage.timeClosedAt) {
            currentUsage.timeClosedAt = closedAtMs;
          }
        }

        sessionMaterialUsage.set(materialUseKey, currentUsage);
      }

      const record = {
        year: String(occurredAt.getUTCFullYear()),
        month: MONTH_NAMES[occurredAt.getUTCMonth()],
        monthIndex: occurredAt.getUTCMonth(),
        division,
        team,
        psr,
        brand,
        product: productName,
        module: moduleLabel,
        sessionId,
        count: 1,
      };

      if (includeDashboardMetrics) {
        yearEventRecords.push(record);
      }

      if (isLegacySlideEvent) {
        yearLegacySlideActivityExportRecords.push({
          date: occurredAt.toISOString().slice(0, 10),
          year: record.year,
          month: record.month,
          monthIndex: record.monthIndex,
          division,
          team,
          psr,
          brand,
          product: productName,
          module: moduleLabel,
          material: materialLabel,
          slide: slideExportName || `Slide ${slideNumber}`,
          slideNumber,
          sessionId,
          deckId,
          occurredAt: occurredAt.toISOString(),
        });
      }

      if (includeDashboardMetrics) {
        const brandDuration = sessionBrandDurations.get(brand) || {
          year: record.year,
          month: record.month,
          monthIndex: record.monthIndex,
          division,
          team,
          psr,
          brand,
          durationSeconds: 0,
        };
        brandDuration.durationSeconds += 1;
        sessionBrandDurations.set(brand, brandDuration);

        const moduleDurationKey = `${brand}__${moduleLabel}`;
        const moduleDuration = sessionModuleDurations.get(moduleDurationKey) || {
          year: record.year,
          month: record.month,
          monthIndex: record.monthIndex,
          division,
          team,
          psr,
          brand,
          module: moduleLabel,
          durationSeconds: 0,
        };
        moduleDuration.durationSeconds += 1;
        sessionModuleDurations.set(moduleDurationKey, moduleDuration);
      }
    });

    if (includeDashboardMetrics) {
      const brandEntries = Array.from(sessionBrandDurations.values());
      if (brandEntries.length > 0) {
        const perBrandSeconds = Math.max(30, Math.round(sessionDurationSeconds / brandEntries.length));
        brandEntries.forEach((entry) => {
          yearBrandTimeRecords.push({
            ...entry,
            durationSeconds: perBrandSeconds,
          });
        });
      }

      const moduleEntries = Array.from(sessionModuleDurations.values());
      if (moduleEntries.length > 0) {
        const perModuleSeconds = Math.max(30, Math.round(sessionDurationSeconds / moduleEntries.length));
        moduleEntries.forEach((entry) => {
          yearModuleTimeRecords.push({
            ...entry,
            durationSeconds: perModuleSeconds,
          });
        });
      }
    }

    yearMaterialUsageRecords.push(
      ...Array.from(sessionMaterialUsage.values()).map((entry) => ({
        ...entry,
        timeOpenedAt: entry.timeOpenedAt ? new Date(entry.timeOpenedAt).toISOString() : "",
        timeClosedAt: entry.timeClosedAt ? new Date(entry.timeClosedAt).toISOString() : "",
      }))
    );
  });

  slideRetentionRows.forEach((row) => {
    const endedAt = new Date(row?.endedAt || 0);
    if (Number.isNaN(endedAt.getTime()) || isDateAfterCutoff(endedAt, reportCutoffTime)) return;

    const user = userById.get(String(row?.userId || ""));
    if (isUsageExcludedUser(user)) return;

    const product = resolveRetentionProduct(row, productById, productLookup);
    const productName = normalizeText(product?.name);
    if (!productName || isUnknownProduct(productName)) return;

    const details = row?.details || {};
    const brand = getBrandLabel(product, details);
    const division = getDivisionLabel(user);
    const canonicalAttachmentLabel = getCachedCanonicalMediaLabel(product, {
      deckTitle: row?.deckTitle,
      presentationTitle: row?.presentationTitle,
      caseName: row?.caseName,
      sourceName: details?.sourceName,
      groupTitle: details?.groupTitle,
      title: details?.title,
      deckId: row?.deckId,
      caseId: row?.caseId,
    });
    const deckTitle = cleanModuleLabel(row?.deckTitle || row?.presentationTitle || "");
    const attachmentLabel =
      canonicalAttachmentLabel || deckTitle || cleanModuleLabel(product?.name || row?.presentationTitle || "Untitled Attachment");
    const slideNumber = Number.isFinite(Number(row?.slideNumber))
      ? Math.max(1, Math.round(Number(row.slideNumber)))
      : Math.max(1, Math.round(Number(row?.slideIndex || 0)) + 1);
    const rawSlideTitle = cleanModuleLabel(row?.slideTitle || "");
    const slideLabel =
      rawSlideTitle && rawSlideTitle.toLowerCase() !== attachmentLabel.toLowerCase()
        ? rawSlideTitle
        : `Slide ${slideNumber}`;
    const slideExportName = getCachedRetentionSlideExportName(row, product);

    yearSlideRetentionRecords.push({
      date: endedAt.toISOString().slice(0, 10),
      year: String(endedAt.getUTCFullYear()),
      month: MONTH_NAMES[endedAt.getUTCMonth()],
      monthIndex: endedAt.getUTCMonth(),
      userId: normalizeText(row?.userId),
      sessionId: normalizeText(row?.sessionId),
      division,
      team: getTeamLabel(user),
      psr: getRepLabel(user),
      brand,
      product: productName,
      caseId: normalizeText(row?.caseId),
      deckId: normalizeText(row?.deckId || row?.caseId),
      attachment: attachmentLabel,
      slide: slideLabel,
      slideExportName,
      slideNumber,
      // Group retention by product + attachment + slide number so mixed IDs still aggregate into one slide bar.
      slideKey:
        `${productName}::${attachmentLabel}::${slideNumber}` ||
        normalizeText(row?.slideId) ||
        `${normalizeText(row?.deckId) || attachmentLabel}::${slideNumber}::${slideLabel}` ||
        "attachment",
      slideLabel,
      startedAt: row?.startedAt || null,
      endedAt: row?.endedAt || null,
      durationMs: Number(row?.durationMs || 0),
      durationSeconds: Number(row?.durationSeconds || Number(row?.durationMs || 0) / 1000 || 0),
      durationMinutes: Number(row?.durationMinutes || Number(row?.durationMs || 0) / 60000 || 0),
      views: 1,
    });
  });

  const filterSourceRecords = includeDashboardMetrics
    ? [...yearEventRecords, ...yearSlideRetentionRecords]
    : [...yearMaterialUsageRecords, ...yearLegacySlideActivityExportRecords, ...yearSlideRetentionRecords];
  const filterRelationships = buildFilterRelationships(reportUsers, filterSourceRecords);
  const {
    divisionOptions,
    teamOptions,
    psrOptions,
    selectedDivision,
    selectedTeam,
    selectedPsr,
  } = resolveScopedEntityFilters(filterRelationships, inputFilters);
  const brandOptions = [
    EMPTY_FILTER_VALUE,
    ...uniqueSorted(filterSourceRecords.map((record) => record.brand)).filter((brand) => !isExcludedBrandFilterOption(brand)),
  ];

  const filters = {
    year: selectedYear,
    month: selectedMonth,
    division: selectedDivision,
    team: selectedTeam,
    psr: selectedPsr,
    brand: normalizeFilterValue(inputFilters.brand, brandOptions, EMPTY_FILTER_VALUE),
  };

  const matchesFilter = buildMatchesFilter(filters);
  const matchesMonth = (record) =>
    filters.month === EMPTY_FILTER_VALUE ? true : record.monthIndex === selectedMonthIndex;

  const selectedMonthEventRecords = includeDashboardMetrics
    ? yearEventRecords.filter((record) => matchesMonth(record) && matchesFilter(record))
    : [];
  const selectedMonthModuleTimeRecords = includeDashboardMetrics
    ? yearModuleTimeRecords.filter((record) => matchesMonth(record) && matchesFilter(record))
    : [];
  const selectedMonthBrandTimeRecords = includeDashboardMetrics
    ? yearBrandTimeRecords.filter((record) => matchesMonth(record) && matchesFilter(record))
    : [];
  const selectedMonthSlideRetentionRecords = yearSlideRetentionRecords.filter(
    (record) => matchesMonth(record) && matchesFilter(record)
  );
  const selectedMonthMaterialUsageRecords = yearMaterialUsageRecords.filter(
    (record) => matchesMonth(record) && matchesFilter(record)
  );
  const selectedMonthLegacySlideActivityExportRecords = yearLegacySlideActivityExportRecords.filter(
    (record) => matchesMonth(record) && matchesFilter(record)
  );
  const selectedYearEventRecords = includeDashboardMetrics ? yearEventRecords.filter(matchesFilter) : [];

  return {
    filters: {
      yearOptions,
      monthOptions,
      divisionOptions,
      teamOptions,
      psrOptions,
      brandOptions,
      selected: filters,
    },
    products,
    totalIncludedSessions: includedLogCount,
    selectedMonthEventRecords,
    selectedMonthModuleTimeRecords,
    selectedMonthBrandTimeRecords,
    selectedMonthMaterialUsageRecords,
    selectedMonthLegacySlideActivityExportRecords,
    selectedMonthSlideRetentionRecords,
    selectedYearEventRecords,
  };
}

function createDashboardFilterPayload(filters) {
  return {
    filters,
  };
}

function createDashboardOverviewPayload(source) {
  const {
    filters,
    totalIncludedSessions = 0,
    selectedMonthEventRecords,
    selectedMonthBrandTimeRecords,
    selectedMonthSlideRetentionRecords,
  } = source;
  const selectedFilters = filters?.selected || {};

  const shareOfVoiceBrandMap = new Map();
  selectedMonthEventRecords.forEach((record) =>
    incrementMap(shareOfVoiceBrandMap, toLegacyBrandShareLabel(record.brand), record.count)
  );

  const shareOfVoiceAppMap = new Map();
  selectedMonthBrandTimeRecords.forEach((record) =>
    incrementMap(shareOfVoiceAppMap, toLegacyBrandShareLabel(record.brand), record.durationSeconds)
  );

  const teamRankings = buildRankingRows(
    selectedMonthEventRecords.map((record) => ({
      year: selectedFilters.year,
      month: selectedFilters.month,
      team: record.team,
      brand: record.brand,
      count: record.count,
    })),
    ["year", "month", "team", "brand"],
    20
  );

  const repRankings = buildRankingRows(
    selectedMonthEventRecords.map((record) => ({
      year: selectedFilters.year,
      month: selectedFilters.month,
      team: record.team,
      psr: record.psr,
      brand: record.brand,
      count: record.count,
    })),
    ["year", "month", "team", "psr", "brand"],
    20
  );

  return {
    filters,
    shareOfVoiceBrand: buildPercentRows(shareOfVoiceBrandMap, Math.max(LEGACY_BRAND_SHARE_LABELS.length, shareOfVoiceBrandMap.size), {
      includeLabels: LEGACY_BRAND_SHARE_LABELS,
    }),
    shareOfVoiceApp: buildPercentRows(
      shareOfVoiceAppMap,
      Math.max(LEGACY_BRAND_SHARE_LABELS.length, shareOfVoiceAppMap.size),
      {
        includeLabels: LEGACY_BRAND_SHARE_LABELS,
      rawValueKey: "minutes",
      rawValueTransform: (seconds) => Number(seconds || 0) / 60,
      }
    ),
    teamRankings,
    repRankings,
    meta: {
      totalSessionsInYear: totalIncludedSessions,
      totalInteractionsInMonth: selectedMonthEventRecords.length,
      totalSlideViewsInMonth: selectedMonthSlideRetentionRecords.length,
      totalSlideMinutesInMonth: Number(
        sumValues(selectedMonthSlideRetentionRecords.map((record) => record.durationMinutes)).toFixed(2)
      ),
    },
  };
}

function createDashboardModulesPayload(source) {
  const {
    filters,
    products,
    selectedMonthEventRecords,
    selectedMonthModuleTimeRecords,
  } = source;

  return {
    filters,
    generalCountModules: buildTopModuleRows(selectedMonthEventRecords, "count", 9),
    generalTimeModules: buildTopModuleRows(mapModuleTimeRecordsToMinuteCount(selectedMonthModuleTimeRecords), "count", 9),
    brandTotalModules: buildTopModuleRows(selectedMonthEventRecords, "count", 7),
    movingMonthly: buildMovingMonthlyModules(selectedMonthEventRecords, 7),
    materialSummaryGroups: MATERIAL_SUMMARY_GROUPS.map((group) =>
      buildMaterialSummaryGroupPayload({
        ...group,
        products,
        monthEventRecords: selectedMonthEventRecords,
        monthModuleTimeRecords: selectedMonthModuleTimeRecords,
        periodEventRecords: selectedMonthEventRecords,
      })
    ),
  };
}

function createDashboardTeamPayload(source) {
  const { filters, selectedMonthEventRecords } = source;
  const teamChartRecords = selectedMonthEventRecords.filter((record) => !isUnassignedTeam(record?.team));
  const visibleTeamLabels = (Array.isArray(filters?.teamOptions) ? filters.teamOptions : []).filter(
    (label) => normalizeText(label) && normalizeText(label) !== EMPTY_FILTER_VALUE && !isUnassignedTeam(label)
  );

  return {
    filters,
    allPerTeam: buildSeriesChart(teamChartRecords, 8, "team", null, {
      includeSeriesLabels: visibleTeamLabels,
    }),
    divisionPerTeam: buildSeriesChart(selectedMonthEventRecords, 7, "division", 6),
    specialtyCharts: buildSpecialtyCharts(selectedMonthEventRecords),
  };
}

function createDashboardSlidesPayload(source, options = {}) {
  const {
    filters,
    selectedMonthSlideRetentionRecords,
    selectedMonthMaterialUsageRecords,
    selectedMonthLegacySlideActivityExportRecords,
  } = source;
  const { includeExportRows = true } = options;

  if (!includeExportRows) {
    return {
      filters,
      slideRetentionSlides: buildSlideRetentionRows(selectedMonthSlideRetentionRecords),
    };
  }

  const slideActivityExportRows = buildSlideActivityExportRows(
    selectedMonthSlideRetentionRecords,
    selectedMonthMaterialUsageRecords
  );
  const fallbackSlideActivityExportRows =
    slideActivityExportRows.length > 0
      ? slideActivityExportRows
      : buildLegacySlideActivityExportRows(selectedMonthLegacySlideActivityExportRecords);
  const materialOpenExportRows = buildMaterialOpenExportRows(selectedMonthMaterialUsageRecords);
  const fallbackMaterialOpenExportRows =
    materialOpenExportRows.length > 0
      ? materialOpenExportRows
      : buildMaterialOpenRowsFromSlideActivityRows(fallbackSlideActivityExportRows);

  return {
    filters,
    slideRetentionSlides: buildSlideRetentionRows(selectedMonthSlideRetentionRecords),
    slideActivityExportRows: fallbackSlideActivityExportRows,
    materialOpenExportRows: fallbackMaterialOpenExportRows,
    materialOpenCountExportRows: buildMaterialOpenCountExportRows(
      selectedMonthMaterialUsageRecords.length > 0 ? selectedMonthMaterialUsageRecords : fallbackMaterialOpenExportRows
    ),
  };
}


const toSlideActivityExportPayloadRows = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    date: row?.date || "",
    year: row?.year || "",
    month: row?.month || "",
    team: row?.team || "",
    psr: row?.psr || "",
    brand: row?.brand || "",
    productName: row?.productName || row?.product || "",
    material: row?.material || "",
    slide: row?.slide || "",
    secondsViewed: Number(row?.secondsViewed || 0),
    secondsIdle: Number(row?.secondsIdle || 0),
    timeSlideOpenedAt: row?.timeSlideOpenedAt || row?.startedAt || "",
    timeSlideClosedAt: row?.timeSlideClosedAt || row?.endedAt || "",
  }));

const toMaterialOpenExportPayloadRows = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    date: row?.date || "",
    year: row?.year || "",
    month: row?.month || "",
    team: row?.team || "",
    psr: row?.psr || "",
    brand: row?.brand || "",
    productName: row?.productName || row?.product || "",
    material: row?.material || "",
    timeOpenedAt: row?.timeOpenedAt || row?.startedAt || "",
    timeClosedAt: row?.timeClosedAt || row?.endedAt || "",
  }));

const toMaterialOpenCountExportPayloadRows = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    date: row?.date || "",
    year: row?.year || "",
    month: row?.month || "",
    team: row?.team || "",
    psr: row?.psr || "",
    brand: row?.brand || "",
    productName: row?.productName || row?.product || "",
    material: row?.material || "",
    openCountPerDay: Number(row?.openCountPerDay || 0),
  }));

function createDashboardExportPayload(source) {
  const {
    filters,
    selectedMonthSlideRetentionRecords,
    selectedMonthMaterialUsageRecords,
    selectedMonthLegacySlideActivityExportRecords,
  } = source;
  const slideActivityExportRows = buildSlideActivityExportRows(
    selectedMonthSlideRetentionRecords,
    selectedMonthMaterialUsageRecords
  );
  const fallbackSlideActivityExportRows =
    slideActivityExportRows.length > 0
      ? slideActivityExportRows
      : buildLegacySlideActivityExportRows(selectedMonthLegacySlideActivityExportRecords);
  const materialOpenExportRows = buildMaterialOpenExportRows(selectedMonthMaterialUsageRecords);
  const fallbackMaterialOpenExportRows =
    materialOpenExportRows.length > 0
      ? materialOpenExportRows
      : buildMaterialOpenRowsFromSlideActivityRows(fallbackSlideActivityExportRows);

  return {
    filters,
    slideActivityExportRows: toSlideActivityExportPayloadRows(fallbackSlideActivityExportRows),
    materialOpenExportRows: toMaterialOpenExportPayloadRows(fallbackMaterialOpenExportRows),
    materialOpenCountExportRows: toMaterialOpenCountExportPayloadRows(
      buildMaterialOpenCountExportRows(
        selectedMonthMaterialUsageRecords.length > 0 ? selectedMonthMaterialUsageRecords : fallbackMaterialOpenExportRows
      )
    ),
  };
}

function createDashboardNationalPayload(source) {
  const { filters, products, selectedMonthEventRecords } = source;

  return {
    filters,
    nationalUtilization: {
      tdShareOfVoice: buildPercentRowsFromProductGroups(selectedMonthEventRecords, "product", TD_PRODUCT_GROUPS),
      cnsShareOfVoice: buildMaterialShareRowsForProductGroups(selectedMonthEventRecords, products, CNS_PRODUCT_GROUPS),
    },
  };
}

function createDashboardUtilizationTeamPayload(source) {
  const {
    filters,
    products,
    selectedMonthEventRecords,
    selectedMonthSlideRetentionRecords,
  } = source;

  return {
    filters,
    teamUtilization: {
      perTeam: buildTotalRows(selectedMonthEventRecords, "team", 20),
      perPsr: buildTotalRows(selectedMonthEventRecords, "psr", 20),
      perProduct: buildProductTotalRows(selectedMonthEventRecords, products),
      perSlide: buildSlideMetricRows(selectedMonthSlideRetentionRecords, "total", 20),
      averageTimePerSlide: buildSlideMetricRows(selectedMonthSlideRetentionRecords, "average", 20),
    },
  };
}

function createDashboardSummaryPayload(source) {
  const {
    filters,
    products,
    selectedMonthEventRecords,
    selectedMonthSlideRetentionRecords,
    selectedYearEventRecords,
  } = source;

  return {
    filters,
    legacyOverview: {
      monthly: {
        product: buildProductTotalRows(selectedMonthEventRecords, products),
        person: buildTotalRows(selectedMonthEventRecords, "psr", 20),
        team: buildTotalRows(selectedMonthEventRecords, "team", 20),
      },
      yearly: {
        product: buildProductTotalRows(selectedYearEventRecords, products),
        person: buildTotalRows(selectedYearEventRecords, "psr", 10),
        team: buildTotalRows(selectedYearEventRecords, "team", 10),
      },
    },
    meta: {
      monthlyTotalInteractions: selectedMonthEventRecords.length,
      yearlyTotalInteractions: selectedYearEventRecords.length,
      monthlyTotalSlideViews: selectedMonthSlideRetentionRecords.length,
      monthlyTotalSlideMinutes: Number(
        sumValues(selectedMonthSlideRetentionRecords.map((record) => record.durationMinutes)).toFixed(2)
      ),
    },
  };
}

function serializeDashboardFilters(inputFilters = {}) {
  return JSON.stringify({
    year: normalizeText(inputFilters.year),
    month: normalizeText(inputFilters.month),
    division: normalizeText(inputFilters.division),
    team: normalizeText(inputFilters.team),
    psr: normalizeText(inputFilters.psr),
    brand: normalizeText(inputFilters.brand),
  });
}

async function getCachedDashboardReportSource(inputFilters = {}, options = {}) {
  const cacheKey = JSON.stringify({
    section: options?.section || "full",
    filters: JSON.parse(serializeDashboardFilters(inputFilters)),
  });
  const now = Date.now();
  const cachedEntry = dashboardSourceCache.get(cacheKey);

  if (cachedEntry && cachedEntry.expiresAt > now) {
    return cachedEntry.promise;
  }

  const promise = buildDashboardReportSource(inputFilters, options);
  dashboardSourceCache.set(cacheKey, {
    expiresAt: now + DASHBOARD_SOURCE_CACHE_TTL_MS,
    promise,
  });

  try {
    const source = await promise;
    dashboardSourceCache.set(cacheKey, {
      expiresAt: Date.now() + DASHBOARD_SOURCE_CACHE_TTL_MS,
      promise: Promise.resolve(source),
    });
    return source;
  } catch (error) {
    dashboardSourceCache.delete(cacheKey);
    throw error;
  }
}

export async function getDashboardReportSection(inputFilters = {}, section = "full") {
  const source = await getCachedDashboardReportSource(inputFilters, {
    section: section === "exports" ? "exports" : "full",
  });

  switch (section) {
    case "filters":
      return createDashboardFilterPayload(source.filters);
    case "summary":
      return createDashboardSummaryPayload(source);
    case "overview":
      return createDashboardOverviewPayload(source);
    case "modules":
      return createDashboardModulesPayload(source);
    case "team":
      return createDashboardTeamPayload(source);
    case "slides":
      return createDashboardSlidesPayload(source);
    case "exports":
      return createDashboardExportPayload(source);
    case "national":
    case "utilization-national":
      return createDashboardNationalPayload(source);
    case "team-utilization":
    case "utilization-team":
      return createDashboardUtilizationTeamPayload(source);
    case "full":
    default:
      const filtersPayload = createDashboardFilterPayload(source.filters);
      const summaryPayload = createDashboardSummaryPayload(source);
      const overviewPayload = createDashboardOverviewPayload(source);
      const modulesPayload = createDashboardModulesPayload(source);
      const teamPayload = createDashboardTeamPayload(source);
      const slidesPayload = createDashboardSlidesPayload(source, { includeExportRows: false });
      const nationalPayload = createDashboardNationalPayload(source);
      const utilizationTeamPayload = createDashboardUtilizationTeamPayload(source);

      return {
        ...filtersPayload,
        ...summaryPayload,
        ...overviewPayload,
        ...modulesPayload,
        ...teamPayload,
        ...slidesPayload,
        ...nationalPayload,
        ...utilizationTeamPayload,
        meta: {
          ...(overviewPayload.meta || {}),
          ...(summaryPayload.meta || {}),
        },
      };
  }
}

export async function getDashboardReport(inputFilters = {}) {
  return getDashboardReportSection(inputFilters, "full");
}
