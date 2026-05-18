"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const toSlug = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildProductSlug = (product) =>
  toSlug(`${product?.name || ""}-${product?.brandName || product?.brand || ""}`);

const FALLBACK_IMAGE = "/images/product-fallback.svg";
const CONVERTED_PREFIX = "/uploads/converted/";
const stripUrlSuffix = (value = "") => String(value || "").split("#")[0].split("?")[0].trim();

const isImageUrl = (value = "") => /(png|jpg|jpeg|gif|webp)$/i.test(stripUrlSuffix(value));
const isHtmlFilename = (value = "") => /\.(html|htm)$/i.test(stripUrlSuffix(value));

const toMediaVersionToken = (product = {}) => {
  const rawValue =
    product?.updatedAt ||
    product?.updated_at ||
    product?.modifiedAt ||
    product?.createdAt ||
    "";
  if (!rawValue) return "";
  const timestamp = new Date(rawValue).getTime();
  if (Number.isFinite(timestamp) && timestamp > 0) return String(timestamp);
  return String(rawValue).trim();
};

const withMediaVersion = (url = "", version = "") => {
  const clean = stripUrlSuffix(url);
  if (!clean || !version || !clean.startsWith("/uploads/")) return clean || url;
  const params = new URLSearchParams();
  params.set("v", version);
  return `${clean}?${params.toString()}`;
};

const toDisplayMediaUrl = (rawUrl = "", version = "") => {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  const clean = stripUrlSuffix(text);
  if (!clean) return "";
  return clean !== text ? text : withMediaVersion(clean, version);
};

const isHtmlMediaItem = (item = {}) =>
  String(item?.type || "").toLowerCase() === "html" || isHtmlFilename(item?.url || "");

const getHotspotPreviewUrl = (item = {}) => {
  if (isImageUrl(item?.url || "")) return item.displayUrl || item.url;
  if (isHtmlMediaItem(item)) return String(item?.displayThumbnailUrl || item?.thumbnailUrl || "").trim();
  return "";
};

const getFilenameFromUrl = (value = "") => {
  const clean = String(value || "").split("#")[0].split("?")[0];
  return clean.split("/").pop() || clean;
};

const pickFirstNonEmptyString = (...values) => {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
};

const toFlatMedia = (media = []) => {
  if (!Array.isArray(media) || media.length === 0) return [];
  if (media[0] && Array.isArray(media[0].items)) {
    return media.flatMap((group) =>
      (group.items || []).map((item) => ({
        ...item,
        url: item?.url,
        groupId: group.groupId || item?.groupId,
        groupTitle: item?.groupTitle || group?.title || "",
      }))
    );
  }
  return media;
};

const mapProduct = (product) => {
  const mediaVersion = toMediaVersionToken(product);
  const flatMedia = toFlatMedia(product.media);
  const thumbnailUrl = stripUrlSuffix(product.thumbnailUrl || "");
  const thumbnailDisplayUrl = toDisplayMediaUrl(product.thumbnailUrl || thumbnailUrl, mediaVersion);
  const media = flatMedia.map((item) => {
    const itemUrl = stripUrlSuffix(item?.url || "");
    const itemThumbnailUrl = stripUrlSuffix(item?.thumbnailUrl || "");
    return {
      url: itemUrl,
      displayUrl: toDisplayMediaUrl(item?.url || itemUrl, mediaVersion),
      thumbnailUrl: itemThumbnailUrl,
      displayThumbnailUrl: toDisplayMediaUrl(item?.thumbnailUrl || itemThumbnailUrl, mediaVersion),
      type: item.type,
      title: item.title,
      groupTitle: item.groupTitle,
      size: item.size,
      status: item.status,
      groupId: item.groupId,
      sourceName: item.sourceName,
      hotspots: Array.isArray(item?.hotspots)
        ? item.hotspots.map((hotspot) => ({
            ...hotspot,
            targetPageId: stripUrlSuffix(hotspot?.targetPageId || ""),
          }))
        : [],
    };
  });
  const image = thumbnailUrl || media?.[0]?.url || FALLBACK_IMAGE;
  const imageDisplay = thumbnailDisplayUrl || media?.[0]?.displayUrl || FALLBACK_IMAGE;

  return {
    id: product._id?.toString?.() || product._id || product.id || "",
    slug: buildProductSlug(product),
    name: product.name,
    brand: product.brandName || "",
    category: product.category,
    description: product.description,
    image,
    imageDisplay,
    thumbnailUrl,
    thumbnailDisplayUrl,
    mediaVersion,
    media,
  };
};

const Toast = ({ toast, onClose }) => {
  if (!toast) return null;
  const tone =
    toast.type === "success"
      ? "bg-green-600"
      : toast.type === "error"
      ? "bg-red-600"
      : "bg-blue-600";
  return (
    <div className="fixed top-6 right-6 z-50">
      <div className={`${tone} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3`}>
        <span className="text-sm font-medium">{toast.message}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-white/80 hover:text-white"
        >
          x
        </button>
      </div>
    </div>
  );
};

const groupExistingMedia = (mediaItems) => {
  const groups = new Map();

  mediaItems.forEach((item) => {
    const url = item.url || "";
    const preferredLabel = pickFirstNonEmptyString(
      item.groupTitle,
      item.sourceName,
      item.originalName,
      item.groupId
    );
    if (item.groupId) {
      const key = `group:${item.groupId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: preferredLabel,
          sourceName: item.sourceName || item.originalName || item.groupId || "",
          groupTitle: item.groupTitle || "",
          items: [],
        });
      }
      groups.get(key).items.push(item);
      return;
    }
    const convertedIndex = url.indexOf(CONVERTED_PREFIX);
    if (convertedIndex !== -1) {
      const rest = url.slice(convertedIndex + CONVERTED_PREFIX.length);
      const folderName = rest.split("/")[0] || "converted";
      const labelBase = folderName.replace(/^\d+-/, "");
      const label = labelBase ? `${labelBase} (converted)` : "Converted media";
      const key = `converted:${folderName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: pickFirstNonEmptyString(preferredLabel, label),
          sourceName: item.sourceName || item.originalName || label,
          groupTitle: item.groupTitle || "",
          items: [],
        });
      }
      groups.get(key).items.push(item);
      return;
    }

    const filename = url.split("/").pop() || url || "Media file";
    const key = `file:${filename}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: pickFirstNonEmptyString(preferredLabel, filename),
        sourceName: item.sourceName || item.originalName || filename,
        groupTitle: item.groupTitle || "",
        items: [],
      });
    }
    groups.get(key).items.push(item);
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    items: [...(group.items || [])],
  }));
};

const getGroupId = (group) => {
  const first = group.items?.[0];
  if (first?.groupId) return first.groupId;
  if (group.key?.startsWith("group:")) return group.key.replace("group:", "");
  if (group.key?.startsWith("converted:")) return group.key.replace("converted:", "");
  if (group.key?.startsWith("file:")) return group.key.replace("file:", "");
  return group.key || "unknown-group";
};

const buildGroupPages = (group, mediaVersion = "") =>
  (group.items || [])
    .map((item) => ({
      item,
      previewUrl: getHotspotPreviewUrl(item),
    }))
    .filter(({ previewUrl }) => Boolean(previewUrl))
    .map(({ item, previewUrl }, idx) => ({
      pageId: item.url,
      index: idx + 1,
      imageUrl: withMediaVersion(previewUrl, mediaVersion),
      filename: getFilenameFromUrl(item.url),
      type: item.type,
    }));

const getHotspotCount = (item) =>
  Array.isArray(item?.hotspots) ? item.hotspots.length : 0;

const HotspotEditor = ({
  isOpen,
  groupId,
  pages,
  initialHotspotsByPage,
  initialPageId,
  onSave,
  onClose,
}) => {
  const containerRef = useRef(null);
  const [currentPageId, setCurrentPageId] = useState(pages?.[0]?.pageId || "");
  const [hotspotsByPage, setHotspotsByPage] = useState(initialHotspotsByPage || {});
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [draft, setDraft] = useState(null);
  const [isPreview, setIsPreview] = useState(false);
  const [activeAction, setActiveAction] = useState(null);
  const [shape, setShape] = useState("rectangle");
  const [selectionMode, setSelectionMode] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const [clipboardHotspots, setClipboardHotspots] = useState([]);
  const idCounterRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    const preferredPage = initialPageId || pages?.[0]?.pageId || "";
    setCurrentPageId(preferredPage);
    setHotspotsByPage(initialHotspotsByPage || {});
    setSelectedId(null);
    setSelectedIds([]);
    setDraft(null);
    setDrawMode(false);
    setIsPreview(false);
    setActiveAction(null);
    setShape("rectangle");
    setSelectionMode(false);
    setIsSelecting(false);
    setSelectionDraft(null);
    setClipboardHotspots([]);
  }, [isOpen, pages, initialHotspotsByPage, initialPageId]);

  if (!isOpen) return null;

  const currentPage = pages.find((page) => page.pageId === currentPageId) || pages[0];
  const currentPageIndex = pages.findIndex((page) => page.pageId === currentPage?.pageId);
  const hotspots = hotspotsByPage[currentPage?.pageId] || [];
  const selectedSet = new Set(selectedIds);
  const isHotspotSelected = (hotspotId) =>
    selectedSet.has(hotspotId) || (!selectedSet.size && selectedId === hotspotId);
  const selectedCount = selectedSet.size || (selectedId ? 1 : 0);
  const totalHotspots = Object.values(hotspotsByPage || {}).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0
  );

  const updateHotspotsForCurrentPage = (next) => {
    if (!currentPage?.pageId) return;
    setHotspotsByPage((prev) => ({
      ...prev,
      [currentPage.pageId]: next,
    }));
  };

  const getRelativePoint = (event) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
    return { x, y };
  };
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const minSize = 0.02;
  const selectSingle = (id) => {
    setSelectedId(id || null);
    setSelectedIds(id ? [id] : []);
  };
  const makeEditorId = (prefix = "hotspot") => {
    idCounterRef.current += 1;
    return `${prefix}-${idCounterRef.current}`;
  };
  const makeHotspotId = () => makeEditorId("hotspot");
  const normalizeRect = (rect) => {
    if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.min(rect.startX, rect.x);
    const y = Math.min(rect.startY, rect.y);
    const w = Math.abs(rect.x - rect.startX);
    const h = Math.abs(rect.y - rect.startY);
    return { x, y, w, h };
  };
  const intersects = (a, b) =>
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;
  const getSelectedHotspots = () => {
    if (selectedIds.length) {
      const ids = new Set(selectedIds);
      return hotspots.filter((spot) => ids.has(spot.id));
    }
    if (selectedId) {
      const found = hotspots.find((spot) => spot.id === selectedId);
      return found ? [found] : [];
    }
    return [];
  };
  const cloneHotspots = (source, { withOffset = false } = {}) =>
    source.map((spot, index) => {
      const delta = withOffset ? 0.02 * (index + 1) : 0;
      const w = clamp(spot.w || 0, minSize, 1);
      const h = clamp(spot.h || 0, minSize, 1);
      const x = clamp((spot.x || 0) + delta, 0, 1 - w);
      const y = clamp((spot.y || 0) + delta, 0, 1 - h);
      return {
        ...spot,
        id: makeHotspotId(),
        x,
        y,
        w,
        h,
      };
    });
  const pasteToPage = (pageId, source, { withOffset = false } = {}) => {
    if (!pageId || !Array.isArray(source) || source.length === 0) return [];
    const clones = cloneHotspots(source, { withOffset });
    setHotspotsByPage((prev) => ({
      ...prev,
      [pageId]: [...(prev[pageId] || []), ...clones],
    }));
    return clones;
  };

  const handlePointerDown = (event) => {
    if (!drawMode || !currentPage) return;
    event.preventDefault();
    const start = getRelativePoint(event);
    setIsDrawing(true);
    setDraft({
      id: makeEditorId("draft"),
      x: start.x,
      y: start.y,
      w: 0,
      h: 0,
      startX: start.x,
      startY: start.y,
      shape,
      targetPageId: "",
    });
  };

  const handlePointerMove = (event) => {
    if (!isDrawing || !draft) return;
    event.preventDefault();
    const current = getRelativePoint(event);
    const startX = draft.startX ?? draft.x;
    const startY = draft.startY ?? draft.y;
    const x = Math.min(startX, current.x);
    const y = Math.min(startY, current.y);
    const w = Math.abs(current.x - startX);
    const h = Math.abs(current.y - startY);
    setDraft((prev) => ({ ...prev, x, y, w, h }));
  };

  const handlePointerUp = () => {
    if (!isDrawing || !draft) return;
    setIsDrawing(false);
    if (draft.w < minSize || draft.h < minSize) {
      setDraft(null);
      return;
    }
    const newHotspot = {
      id: makeHotspotId(),
      x: draft.x,
      y: draft.y,
      w: draft.w,
      h: draft.h,
      shape: draft.shape || shape,
      targetPageId: "",
    };
    updateHotspotsForCurrentPage([...hotspots, newHotspot]);
    selectSingle(newHotspot.id);
    setDraft(null);
  };

  const handleSelectionStart = (event) => {
    if (!selectionMode || drawMode || isPreview || !currentPage) return;
    event.preventDefault();
    const start = getRelativePoint(event);
    setIsSelecting(true);
    setSelectionDraft({
      startX: start.x,
      startY: start.y,
      x: start.x,
      y: start.y,
    });
    selectSingle(null);
  };

  const handleSelectionMove = (event) => {
    if (!isSelecting || !selectionDraft) return;
    event.preventDefault();
    const current = getRelativePoint(event);
    setSelectionDraft((prev) => ({
      ...prev,
      x: current.x,
      y: current.y,
    }));
  };

  const handleSelectionEnd = () => {
    if (!isSelecting || !selectionDraft) return;
    const area = normalizeRect(selectionDraft);
    const minSelectSize = 0.005;
    if (area.w < minSelectSize || area.h < minSelectSize) {
      setIsSelecting(false);
      setSelectionDraft(null);
      return;
    }
    const ids = hotspots
      .filter((spot) => intersects(area, { x: spot.x, y: spot.y, w: spot.w, h: spot.h }))
      .map((spot) => spot.id);
    setSelectedIds(ids);
    setSelectedId(ids[0] || null);
    setIsSelecting(false);
    setSelectionDraft(null);
  };

  const beginMove = (event, spot) => {
    if (drawMode || isPreview || selectionMode) return;
    event.preventDefault();
    event.stopPropagation();
    const start = getRelativePoint(event);
    selectSingle(spot.id);
    setActiveAction({
      type: "move",
      id: spot.id,
      start,
      origin: { x: spot.x, y: spot.y, w: spot.w, h: spot.h },
    });
  };

  const beginResize = (event, spot, handle) => {
    if (drawMode || isPreview || selectionMode) return;
    event.preventDefault();
    event.stopPropagation();
    const start = getRelativePoint(event);
    selectSingle(spot.id);
    setActiveAction({
      type: "resize",
      id: spot.id,
      handle,
      start,
      origin: { x: spot.x, y: spot.y, w: spot.w, h: spot.h },
    });
  };

  const handleActionMove = (event) => {
    if (!activeAction) return;
    event.preventDefault();
    const point = getRelativePoint(event);
    const dx = point.x - activeAction.start.x;
    const dy = point.y - activeAction.start.y;
    updateHotspotsForCurrentPage(
      hotspots.map((spot) => {
        if (spot.id !== activeAction.id) return spot;
        if (activeAction.type === "move") {
          const nextX = clamp(
            activeAction.origin.x + dx,
            0,
            1 - activeAction.origin.w
          );
          const nextY = clamp(
            activeAction.origin.y + dy,
            0,
            1 - activeAction.origin.h
          );
          return { ...spot, x: nextX, y: nextY };
        }
        if (activeAction.type === "resize") {
          let { x, y, w, h } = activeAction.origin;
          if (activeAction.handle === "se") {
            w = clamp(activeAction.origin.w + dx, minSize, 1 - x);
            h = clamp(activeAction.origin.h + dy, minSize, 1 - y);
          }
          if (activeAction.handle === "sw") {
            const newX = clamp(activeAction.origin.x + dx, 0, x + w - minSize);
            w = clamp(x + w - newX, minSize, 1 - newX);
            x = newX;
            h = clamp(activeAction.origin.h + dy, minSize, 1 - y);
          }
          if (activeAction.handle === "ne") {
            const newY = clamp(activeAction.origin.y + dy, 0, y + h - minSize);
            h = clamp(y + h - newY, minSize, 1 - newY);
            y = newY;
            w = clamp(activeAction.origin.w + dx, minSize, 1 - x);
          }
          if (activeAction.handle === "nw") {
            const newX = clamp(activeAction.origin.x + dx, 0, x + w - minSize);
            const newY = clamp(activeAction.origin.y + dy, 0, y + h - minSize);
            w = clamp(x + w - newX, minSize, 1 - newX);
            h = clamp(y + h - newY, minSize, 1 - newY);
            x = newX;
            y = newY;
          }
          return { ...spot, x, y, w, h };
        }
        return spot;
      })
    );
  };

  const handleActionEnd = () => {
    if (!activeAction) return;
    setActiveAction(null);
  };

  const handleDeleteSelected = () => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    const selected = new Set(ids);
    updateHotspotsForCurrentPage(hotspots.filter((spot) => !selected.has(spot.id)));
    selectSingle(null);
  };

  const handleCopySelected = () => {
    const selected = getSelectedHotspots();
    if (!selected.length) return;
    const clipboard = selected.map(({ id, ...rest }) => ({ ...rest }));
    setClipboardHotspots(clipboard);
  };

  const handlePasteCurrentPage = () => {
    if (!currentPage?.pageId || !clipboardHotspots.length) return;
    const inserted = pasteToPage(currentPage.pageId, clipboardHotspots, { withOffset: true });
    setSelectedIds(inserted.map((item) => item.id));
    setSelectedId(inserted[0]?.id || null);
  };

  const handlePasteNextPage = () => {
    if (!clipboardHotspots.length) return;
    if (currentPageIndex < 0 || currentPageIndex >= pages.length - 1) return;
    const nextPageId = pages[currentPageIndex + 1]?.pageId;
    const inserted = pasteToPage(nextPageId, clipboardHotspots);
    setCurrentPageId(nextPageId);
    setSelectedIds(inserted.map((item) => item.id));
    setSelectedId(inserted[0]?.id || null);
  };

  const handleSave = () => {
    onSave(hotspotsByPage, currentPage?.pageId || initialPageId || "");
    onClose();
  };

  const handleHotspotClick = (spot) => {
    if (drawMode) {
      setDrawMode(false);
    }
    if (isPreview && spot.targetPageId) {
      setCurrentPageId(spot.targetPageId);
      return;
    }
    if (selectionMode) return;
    selectSingle(spot.id);
  };
  const shapeClassName = (value) => {
    if (value === "circle" || value === "pill") return "rounded-full";
    if (value === "round-rectangle") return "rounded-lg";
    return "rounded-none";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <div className="max-h-[90vh] w-full max-w-6xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Edit Hotspots</h3>
            <p className="text-xs text-gray-500">Group: {groupId}</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            &#10005;
          </button>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDrawMode((prev) => !prev);
                  setIsPreview(false);
                  setSelectionMode(false);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                  drawMode
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-gray-200 text-gray-600"
                }`}
              >
                {drawMode ? "Drawing Hotspot" : "Add Hotspot"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode((prev) => !prev);
                  setDrawMode(false);
                  setIsPreview(false);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                  selectionMode
                    ? "border-amber-500 bg-amber-50 text-amber-700"
                    : "border-gray-200 text-gray-600"
                }`}
              >
                {selectionMode ? "Selecting" : "Select Hotspots"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsPreview((prev) => !prev);
                  setDrawMode(false);
                  setSelectionMode(false);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                  isPreview
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "border-gray-200 text-gray-600"
                }`}
              >
                {isPreview ? "Preview On" : "Preview"}
              </button>
              <button
                type="button"
                onClick={handleCopySelected}
                disabled={selectedCount === 0}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 disabled:opacity-40"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={handlePasteCurrentPage}
                disabled={clipboardHotspots.length === 0}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 disabled:opacity-40"
              >
                Paste Here
              </button>
              <button
                type="button"
                onClick={handlePasteNextPage}
                disabled={clipboardHotspots.length === 0 || currentPageIndex >= pages.length - 1}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 disabled:opacity-40"
              >
                Paste to Next Slide
              </button>
              <div className="flex items-center gap-2">
                {[
                  { value: "rectangle", label: "Rectangle" },
                  { value: "round-rectangle", label: "Round Rect" },
                  { value: "circle", label: "Circle" },
                  { value: "pill", label: "Pill" },
                ].map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setShape(item.value)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                      shape === item.value
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 text-gray-600"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-gray-400">
                {drawMode
                  ? "Drag to draw"
                  : selectionMode
                  ? "Drag area to select multiple hotspots"
                  : "Select a hotspot"}
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">
                {totalHotspots} total
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">
                {selectedCount} selected
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">
                {clipboardHotspots.length} copied
              </span>
            </div>
            <div
              ref={containerRef}
              className="relative overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
              onMouseDown={(event) => {
                handlePointerDown(event);
                handleSelectionStart(event);
              }}
              onMouseMove={(event) => {
                handlePointerMove(event);
                handleActionMove(event);
                handleSelectionMove(event);
              }}
              onMouseUp={() => {
                handlePointerUp();
                handleActionEnd();
                handleSelectionEnd();
              }}
              onMouseLeave={() => {
                handlePointerUp();
                handleActionEnd();
                handleSelectionEnd();
              }}
            >
              {currentPage?.imageUrl ? (
                <img
                  src={currentPage.imageUrl}
                  alt={currentPage.filename || "page"}
                  className="block h-auto w-full select-none object-contain"
                  onMouseDown={(event) => event.preventDefault()}
                  draggable={false}
                />
              ) : (
                <div className="flex h-80 items-center justify-center text-sm text-gray-400">
                  Select a page to edit.
                </div>
              )}
              {hotspots.map((spot, index) => (
                <div
                  key={spot.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleHotspotClick(spot)}
                  onMouseDown={(event) => {
                    if (selectionMode && !drawMode && !isPreview) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedIds((prev) =>
                        prev.includes(spot.id)
                          ? prev.filter((id) => id !== spot.id)
                          : [...prev, spot.id]
                      );
                      setSelectedId(spot.id);
                      return;
                    }
                    if (drawMode) {
                      event.stopPropagation();
                      setDrawMode(false);
                    }
                    selectSingle(spot.id);
                    if (!drawMode && !isPreview) {
                      beginMove(event, spot);
                    }
                  }}
                  className={`absolute ${shapeClassName(spot.shape)} border-2 ${
                    isHotspotSelected(spot.id)
                      ? "border-blue-500 bg-blue-100/40"
                      : "border-amber-400 bg-amber-100/30"
                  } z-10`}
                  style={{
                    left: `${spot.x * 100}%`,
                    top: `${spot.y * 100}%`,
                    width: `${spot.w * 100}%`,
                    height: `${spot.h * 100}%`,
                  }}
                >
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {index + 1}
                  </span>
                  {selectedId === spot.id && !isPreview && !drawMode && !selectionMode && (
                    <>
                      <button
                        type="button"
                        onMouseDown={(event) => beginResize(event, spot, "nw")}
                        className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border border-white bg-blue-600"
                      />
                      <button
                        type="button"
                        onMouseDown={(event) => beginResize(event, spot, "ne")}
                        className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border border-white bg-blue-600"
                      />
                      <button
                        type="button"
                        onMouseDown={(event) => beginResize(event, spot, "sw")}
                        className="absolute -left-1.5 -bottom-1.5 h-3 w-3 rounded-full border border-white bg-blue-600"
                      />
                      <button
                        type="button"
                        onMouseDown={(event) => beginResize(event, spot, "se")}
                        className="absolute -right-1.5 -bottom-1.5 h-3 w-3 rounded-full border border-white bg-blue-600"
                      />
                    </>
                  )}
                </div>
              ))}
              {draft && (
                <div
                  className={`absolute ${shapeClassName(draft.shape)} border-2 border-dashed border-blue-400 bg-blue-100/20`}
                  style={{
                    left: `${draft.x * 100}%`,
                    top: `${draft.y * 100}%`,
                    width: `${draft.w * 100}%`,
                    height: `${draft.h * 100}%`,
                  }}
                />
              )}
              {selectionDraft && (
                <div
                  className="absolute border-2 border-dashed border-amber-500 bg-amber-200/20"
                  style={{
                    left: `${normalizeRect(selectionDraft).x * 100}%`,
                    top: `${normalizeRect(selectionDraft).y * 100}%`,
                    width: `${normalizeRect(selectionDraft).w * 100}%`,
                    height: `${normalizeRect(selectionDraft).h * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
            <div className="rounded-xl border border-gray-200 p-4">
              <div className="text-xs font-semibold uppercase text-gray-500">Pages</div>
              <div className="mt-3 space-y-2">
                {pages.map((page) => (
                  <button
                    key={page.pageId}
                    type="button"
                    onClick={() => setCurrentPageId(page.pageId)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm ${
                      page.pageId === currentPage?.pageId
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 text-gray-700"
                    }`}
                  >
                    <span className="text-xs font-semibold">{page.index}</span>
                    <span className="truncate">{page.filename}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase text-gray-500">Hotspots</div>
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={selectedCount === 0}
                  className="text-xs font-semibold text-red-500 disabled:opacity-40"
                >
                  Delete Selected
                </button>
              </div>
              <div className="mt-2 text-[11px] text-gray-400">
                {hotspots.length} on this slide
              </div>
              <div className="mt-3 space-y-3">
                {hotspots.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
                    No hotspots yet. Use Add Hotspot to draw.
                  </div>
                )}
                {hotspots.map((spot, index) => (
                  <div
                    key={spot.id}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      isHotspotSelected(spot.id)
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectSingle(spot.id)}
                      className="mb-2 text-left font-semibold text-gray-700"
                    >
                      Hotspot {index + 1}
                    </button>
                    <label className="block text-[11px] font-medium text-gray-500">
                      Target slide
                    </label>
                    <label className="mt-2 block text-[11px] font-medium text-gray-500">
                      Shape
                    </label>
                    <select
                      value={spot.shape || "rectangle"}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateHotspotsForCurrentPage(
                          hotspots.map((item) =>
                            item.id === spot.id ? { ...item, shape: value } : item
                          )
                        );
                      }}
                      className="mt-1 w-full rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700"
                    >
                      <option value="rectangle">Rectangle</option>
                      <option value="round-rectangle">Round rectangle</option>
                      <option value="circle">Circle</option>
                      <option value="pill">Pill</option>
                    </select>
                    <select
                      value={spot.targetPageId || ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateHotspotsForCurrentPage(
                          hotspots.map((item) =>
                            item.id === spot.id ? { ...item, targetPageId: value } : item
                          )
                        );
                      }}
                      className="mt-1 w-full rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700"
                    >
                      <option value="">Select target</option>
                      {pages.map((page) => (
                        <option key={page.pageId} value={page.pageId}>
                          Slide {page.index}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
          <div className="text-xs text-gray-400">
            {isPreview
              ? "Preview mode: click a hotspot to jump to its target slide."
              : "Edit mode: select a hotspot to set its target slide."}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Save Hotspots
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function ProductDetailPage() {
  const router = useRouter();
  const { slug } = useParams();
  const [product, setProduct] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mediaFiles, setMediaFiles] = useState([]);
  const [existingMedia, setExistingMedia] = useState([]);
  const mediaInputRef = useRef(null);
  const thumbnailInputRef = useRef(null);
  const [toast, setToast] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isAddingGroupImages, setIsAddingGroupImages] = useState(false);
  const [targetGroupForAdd, setTargetGroupForAdd] = useState(null);
  const [isReplacingImage, setIsReplacingImage] = useState(false);
  const [replaceImageTargetUrl, setReplaceImageTargetUrl] = useState("");
  const [isSettingMediaThumbnail, setIsSettingMediaThumbnail] = useState(false);
  const [mediaThumbnailTargetUrl, setMediaThumbnailTargetUrl] = useState("");
  const [draggingMedia, setDraggingMedia] = useState(null);
  const [dragOverUrl, setDragOverUrl] = useState("");
  const [expandedMediaGroups, setExpandedMediaGroups] = useState({});
  const [lastEditedHotspotItemUrl, setLastEditedHotspotItemUrl] = useState("");
  const formRef = useRef(null);
  const groupImageInputRef = useRef(null);
  const replaceImageInputRef = useRef(null);
  const mediaThumbnailInputRef = useRef(null);
  const hotspotHighlightTimeoutRef = useRef(null);
  const mediaItemRefs = useRef(new Map());
  const [hotspotEditor, setHotspotEditor] = useState({
    isOpen: false,
    groupId: "",
    pages: [],
    initialHotspotsByPage: {},
    initialPageId: "",
  });
  const [isRenamingImage, setIsRenamingImage] = useState(false);
  const [renameImageTargetUrl, setRenameImageTargetUrl] = useState("");
  const [mediaPreview, setMediaPreview] = useState({
    isOpen: false,
    url: "",
    filename: "",
  });

  const closeMediaPreview = () => {
    setMediaPreview({ isOpen: false, url: "", filename: "" });
  };

  const handleMediaChange = (event) => {
    const files = Array.from(event.target.files || []);
    setMediaFiles(files);
  };

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const refreshProduct = async () => {
    try {
      const response = await fetch("/api/products", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const productsPayload = Array.isArray(data) ? data : data?.products;
      if (!Array.isArray(productsPayload)) return;
      const mapped = productsPayload.map(mapProduct);
      const found = mapped.find((item) => item.slug === slug) || null;
      if (found) {
        setProduct(found);
        setExistingMedia(found.media || []);
      }
    } catch (error) {
      console.error("Refresh product error:", error);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const loadProducts = async () => {
      try {
        const response = await fetch("/api/products", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        const productsPayload = Array.isArray(data) ? data : data?.products;
        if (!Array.isArray(productsPayload)) return;
        const mapped = productsPayload.map(mapProduct);
        const found = mapped.find((item) => item.slug === slug) || null;
        if (isMounted) {
          setProduct(found);
          setExistingMedia(found?.media || []);
        }
      } catch (error) {
        console.error("Load product error:", error);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadProducts();
    return () => {
      isMounted = false;
    };
  }, [slug]);

  useEffect(() => {
    const hasPending = existingMedia.some(
      (item) =>
        item?.status === "pending" ||
        (item?.url || "").startsWith("/uploads/queue/")
    );
    if (!hasPending) return undefined;

    const timer = setInterval(() => {
      refreshProduct();
    }, 10000);

    return () => clearInterval(timer);
  }, [existingMedia]);

  useEffect(() => {
    return () => {
      if (hotspotHighlightTimeoutRef.current) {
        clearTimeout(hotspotHighlightTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!mediaPreview.isOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        closeMediaPreview();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mediaPreview.isOpen]);

  useEffect(() => {
    if (!lastEditedHotspotItemUrl) return;
    const itemElement = mediaItemRefs.current.get(lastEditedHotspotItemUrl);
    if (!itemElement) return;
    itemElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [lastEditedHotspotItemUrl, existingMedia]);

  const triggerHotspotSaveHint = (itemUrl = "", itemGroupId = "") => {
    const highlightUrl = String(itemUrl || "").trim();
    if (!highlightUrl) return;

    const groupKey = itemGroupId ? `group:${itemGroupId}` : "";
    if (groupKey) {
      setExpandedMediaGroups((prev) => ({
        ...prev,
        [groupKey]: true,
      }));
    }

    setLastEditedHotspotItemUrl(highlightUrl);
    if (hotspotHighlightTimeoutRef.current) {
      clearTimeout(hotspotHighlightTimeoutRef.current);
    }
    hotspotHighlightTimeoutRef.current = setTimeout(() => {
      setLastEditedHotspotItemUrl("");
      hotspotHighlightTimeoutRef.current = null;
    }, 1800);
  };

  const handleDelete = async () => {
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }
    const confirmed = window.confirm("Delete this product?");
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        throw new Error(errorPayload.error || "Failed to delete product.");
      }
      showToast("success", "Product deleted.");
      setTimeout(() => {
        window.location.href = "/dashboard/products";
      }, 800);
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to delete product.");
      setIsDeleting(false);
    }
  };

  const buildPayloadFromForm = (sourceForm, mediaOverride) => {
    const formData = new FormData(sourceForm);
    return {
      name: String(formData.get("name") || "").trim(),
      brandName: String(formData.get("brandName") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      thumbnailUrl: product?.thumbnailUrl || "",
      media: mediaOverride || existingMedia,
    };
  };

  const persistProduct = async (payload, { silent } = {}) => {
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return null;
    }
    try {
      if (!silent) setIsUpdating(true);
      const isFormData =
        typeof FormData !== "undefined" && payload instanceof FormData;
      const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, {
        method: "PUT",
        headers: isFormData ? undefined : { "Content-Type": "application/json" },
        body: isFormData ? payload : JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        throw new Error(errorPayload.error || "Failed to update product.");
      }
      const updated = await response.json();
      const mapped = mapProduct(updated);
      setProduct(mapped);
      setExistingMedia(mapped.media || []);
      const newSlug = buildProductSlug(mapped);
      if (newSlug && newSlug !== slug) {
        router.replace(`/dashboard/products/${newSlug}`);
      }
      return mapped;
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to update product.");
      return null;
    } finally {
      if (!silent) setIsUpdating(false);
    }
  };

  const handleUpdate = async (event) => {
    event.preventDefault();
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") || "").trim();
    const brandName = String(formData.get("brandName") || "").trim();
    const category = String(formData.get("category") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const thumbnailFile = formData.get("thumbnailFile");
    const hasThumbnailFile =
      thumbnailFile && typeof thumbnailFile === "object" && thumbnailFile.size > 0;

    if (!name || !category || !description) {
      showToast("error", "Name, category, and description are required.");
      return;
    }
    if (!product.thumbnailUrl && !hasThumbnailFile) {
      showToast("error", "Please upload a thumbnail image.");
      return;
    }

    try {
      const updatePayload = new FormData();
      updatePayload.append("name", name);
      updatePayload.append("brandName", brandName);
      updatePayload.append("category", category);
      updatePayload.append("description", description);
      updatePayload.append("media", JSON.stringify(existingMedia));
      if (hasThumbnailFile) {
        updatePayload.append("thumbnailFile", thumbnailFile);
      }
      const mapped = await persistProduct(updatePayload);
      if (!mapped) return;
      showToast("success", "Product updated.");
      if (thumbnailInputRef.current) {
        thumbnailInputRef.current.value = "";
      }
      if (mediaFiles.length) {
        const mediaPayload = new FormData();
        mediaFiles.forEach((file) => mediaPayload.append("mediaFile", file));
        const mediaRes = await fetch(
          `/api/products/${encodeURIComponent(product.id)}/media`,
          { method: "POST", body: mediaPayload }
        );
        if (!mediaRes.ok) {
          const errorPayload = await mediaRes.json().catch(() => ({}));
          throw new Error(errorPayload.error || "Failed to upload media.");
        }
        setMediaFiles([]);
        if (mediaInputRef.current) {
          mediaInputRef.current.value = "";
        }
        await refreshProduct();
        showToast("success", "Media uploaded.");
      }
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to update product.");
    }
  };

  const groupedExistingMedia = groupExistingMedia(existingMedia);
  const updateGroupTitle = (group, nextTitle) => {
    const targetUrls = new Set((group?.items || []).map((item) => item?.url).filter(Boolean));
    setExistingMedia((prev) =>
      prev.map((item) =>
        targetUrls.has(item.url)
          ? { ...item, groupTitle: String(nextTitle || "").trim() }
          : item
      )
    );
  };
  const removeExistingMediaItem = async (targetUrl) => {
    if (!targetUrl) return;
    const confirmed = window.confirm("Remove this file?");
    if (!confirmed) return;
    const nextMedia = existingMedia.filter((item) => item.url !== targetUrl);
    if (!formRef.current) {
      setExistingMedia(nextMedia);
      return;
    }
    const payload = buildPayloadFromForm(formRef.current, nextMedia);
    const updated = await persistProduct(payload, { silent: true });
    if (updated) {
      showToast("success", "File deleted.");
    }
  };

  const openReplaceImagePicker = (targetUrl) => {
    if (!targetUrl || !replaceImageInputRef.current) return;
    setReplaceImageTargetUrl(targetUrl);
    replaceImageInputRef.current.value = "";
    replaceImageInputRef.current.click();
  };

  const handleReplaceImageSelection = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }
    if (!replaceImageTargetUrl) {
      showToast("error", "Target image is missing.");
      return;
    }
    const targetUrl = replaceImageTargetUrl;

    setIsReplacingImage(true);
    try {
      const payload = new FormData();
      payload.append("oldUrl", targetUrl);
      payload.append("mediaFile", file);

      const response = await fetch(
        `/api/products/${encodeURIComponent(product.id)}/media/replace`,
        { method: "POST", body: payload }
      );
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const message =
          [errorPayload.error, errorPayload.details]
            .filter(Boolean)
            .join(" ") || "Failed to replace image.";
        throw new Error(message);
      }

      await refreshProduct();
      showToast("success", "Image replaced. Hotspots were kept.");
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to replace image.");
    } finally {
      setIsReplacingImage(false);
      setReplaceImageTargetUrl("");
      if (replaceImageInputRef.current) {
        replaceImageInputRef.current.value = "";
      }
    }
  };

  const handleRenameImage = async (targetUrl) => {
    if (!targetUrl) return;
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }

    const currentFilename = getFilenameFromUrl(targetUrl);
    const requestedName = window.prompt(
      "Enter the new filename. The current image extension will be kept.",
      currentFilename
    );
    if (requestedName === null) return;

    const trimmedName = String(requestedName || "").trim();
    if (!trimmedName) {
      showToast("error", "Filename is required.");
      return;
    }

    setIsRenamingImage(true);
    setRenameImageTargetUrl(targetUrl);
    try {
      const payload = new FormData();
      payload.append("oldUrl", targetUrl);
      payload.append("newName", trimmedName);

      const response = await fetch(
        `/api/products/${encodeURIComponent(product.id)}/media/rename`,
        { method: "POST", body: payload }
      );
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const message =
          [errorPayload.error, errorPayload.details]
            .filter(Boolean)
            .join(" ") || "Failed to rename image.";
        throw new Error(message);
      }

      const updated = await response.json();
      const mapped = mapProduct(updated);
      setProduct(mapped);
      setExistingMedia(mapped.media || []);
      showToast("success", "Image renamed.");
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to rename image.");
    } finally {
      setIsRenamingImage(false);
      setRenameImageTargetUrl("");
    }
  };

  const openMediaThumbnailPicker = (targetUrl) => {
    if (!targetUrl || !mediaThumbnailInputRef.current) return;
    setMediaThumbnailTargetUrl(targetUrl);
    mediaThumbnailInputRef.current.value = "";
    mediaThumbnailInputRef.current.click();
  };

  const handleMediaThumbnailSelection = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      setMediaThumbnailTargetUrl("");
      return;
    }
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }
    if (!mediaThumbnailTargetUrl) {
      showToast("error", "Target media is missing.");
      return;
    }

    setIsSettingMediaThumbnail(true);
    try {
      const payload = new FormData();
      payload.append("oldUrl", mediaThumbnailTargetUrl);
      payload.append("thumbnailFile", file);

      const response = await fetch(
        `/api/products/${encodeURIComponent(product.id)}/media/thumbnail`,
        { method: "POST", body: payload }
      );
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const message =
          [errorPayload.error, errorPayload.details]
            .filter(Boolean)
            .join(" ") || "Failed to set thumbnail.";
        throw new Error(message);
      }

      await refreshProduct();
      showToast("success", "Thumbnail updated.");
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to set thumbnail.");
    } finally {
      setIsSettingMediaThumbnail(false);
      setMediaThumbnailTargetUrl("");
      if (mediaThumbnailInputRef.current) {
        mediaThumbnailInputRef.current.value = "";
      }
    }
  };

  const reorderMediaInGroup = async (group, sourceUrl, targetUrl) => {
    if (!group?.key || !sourceUrl || !targetUrl || sourceUrl === targetUrl) return;
    const groupUrls = (group?.items || []).map((item) => item?.url).filter(Boolean);
    const sourceIndex = groupUrls.indexOf(sourceUrl);
    const targetIndex = groupUrls.indexOf(targetUrl);
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;

    const reorderedUrls = [...groupUrls];
    const [moved] = reorderedUrls.splice(sourceIndex, 1);
    reorderedUrls.splice(targetIndex, 0, moved);

    const byUrl = new Map(existingMedia.map((item) => [item.url, item]));
    const reorderedGroupItems = reorderedUrls.map((url) => byUrl.get(url)).filter(Boolean);
    const groupUrlSet = new Set(groupUrls);
    let cursor = 0;
    const nextMedia = existingMedia.map((item) =>
      groupUrlSet.has(item.url) ? reorderedGroupItems[cursor++] : item
    );

    setExistingMedia(nextMedia);
    if (!formRef.current) return;
    const payload = buildPayloadFromForm(formRef.current, nextMedia);
    const updated = await persistProduct(payload, { silent: true });
    if (!updated) {
      await refreshProduct();
      return;
    }
    showToast("success", "Order updated.");
  };

  const handleMediaDragStart = (event, group, item) => {
    if (!group?.key || !item?.url) return;
    const payload = { groupKey: group.key, url: item.url };
    setDraggingMedia(payload);
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    }
  };

  const handleMediaDragOver = (event, group, item) => {
    const source = draggingMedia;
    if (!source?.url || !source?.groupKey) return;
    if (source.groupKey !== group?.key || source.url === item?.url) return;
    event.preventDefault();
    setDragOverUrl(item.url || "");
    if (event?.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  };

  const handleMediaDrop = async (event, group, item) => {
    event.preventDefault();
    let source = draggingMedia;
    if (!source?.url || !source?.groupKey) {
      try {
        const parsed = JSON.parse(event?.dataTransfer?.getData("text/plain") || "{}");
        source = parsed;
      } catch {
        source = null;
      }
    }
    setDraggingMedia(null);
    setDragOverUrl("");
    if (!source?.url || !source?.groupKey) return;
    if (source.groupKey !== group?.key || source.url === item?.url) return;
    await reorderMediaInGroup(group, source.url, item.url);
  };

  const handleMediaDragEnd = () => {
    setDraggingMedia(null);
    setDragOverUrl("");
  };

  const handleMediaDragLeave = (event, item) => {
    if (!item?.url) return;
    const currentTarget = event?.currentTarget;
    const relatedTarget = event?.relatedTarget;
    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) return;
    setDragOverUrl((prev) => (prev === item.url ? "" : prev));
  };

  const openGroupImagePicker = (group) => {
    const groupId = getGroupId(group);
    if (!groupId || !groupImageInputRef.current) return;
    setTargetGroupForAdd({
      groupId,
      groupTitle: group.groupTitle || group.label || "",
      sourceName: group.sourceName || group.label || "Manual upload",
    });
    groupImageInputRef.current.value = "";
    groupImageInputRef.current.click();
  };

  const handleGroupImageSelection = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    if (!product?.id) {
      showToast("error", "Product id is missing.");
      return;
    }
    if (!targetGroupForAdd?.groupId) {
      showToast("error", "Target media group is missing.");
      return;
    }

    setIsAddingGroupImages(true);
    try {
      const mediaPayload = new FormData();
      mediaPayload.append("groupId", targetGroupForAdd.groupId);
      mediaPayload.append("groupTitle", targetGroupForAdd.groupTitle || "");
      mediaPayload.append("sourceName", targetGroupForAdd.sourceName || "Manual upload");
      files.forEach((file) => mediaPayload.append("mediaFile", file));

      const mediaRes = await fetch(
        `/api/products/${encodeURIComponent(product.id)}/media`,
        { method: "POST", body: mediaPayload }
      );
      if (!mediaRes.ok) {
        const errorPayload = await mediaRes.json().catch(() => ({}));
        throw new Error(errorPayload.error || "Failed to add files.");
      }
      await refreshProduct();
      showToast("success", `${files.length} file${files.length === 1 ? "" : "s"} added.`);
    } catch (error) {
      console.error(error);
      showToast("error", error.message || "Failed to add files.");
    } finally {
      setIsAddingGroupImages(false);
      setTargetGroupForAdd(null);
      if (groupImageInputRef.current) {
        groupImageInputRef.current.value = "";
      }
    }
  };

  const openHotspotEditor = (group, item) => {
    const pages = buildGroupPages(group, product?.mediaVersion || "");
    if (!pages.length) {
      showToast("error", "Add an image or set an HTML thumbnail before editing hotspots.");
      return;
    }
    setExpandedMediaGroups((prev) => ({
      ...prev,
      [group.key]: true,
    }));
    const groupId = getGroupId(group);
    const initialHotspotsByPage = pages.reduce((acc, page) => {
      const mediaItem = existingMedia.find((entry) => entry.url === page.pageId);
      acc[page.pageId] = Array.isArray(mediaItem?.hotspots) ? mediaItem.hotspots : [];
      return acc;
    }, {});
    const initialPageId = pages.some((page) => page.pageId === item.url)
      ? item.url
      : pages[0]?.pageId || "";
    setHotspotEditor({
      isOpen: true,
      groupId,
      pages,
      initialHotspotsByPage,
      initialPageId,
    });
  };

  const saveHotspotsForGroup = async (nextHotspotsByPage, activePageId = "") => {
    const nextMedia = existingMedia.map((item) =>
      nextHotspotsByPage[item.url]
        ? { ...item, hotspots: nextHotspotsByPage[item.url] }
        : item
    );
    const activeItem = nextMedia.find((item) => item.url === activePageId);
    setExistingMedia(nextMedia);
    triggerHotspotSaveHint(activePageId, activeItem?.groupId || "");
    if (!formRef.current) return;
    const payload = buildPayloadFromForm(formRef.current, nextMedia);
    const updated = await persistProduct(payload, { silent: true });
    if (updated) {
      showToast("success", "Hotspots saved.");
      return;
    }
    setLastEditedHotspotItemUrl("");
  };

  return (
    <div className="space-y-8">
      <Toast toast={toast} onClose={() => setToast(null)} />
      {mediaPreview.isOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-label={mediaPreview.filename || "Media preview"}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeMediaPreview();
            }
          }}
        >
          <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <div className="text-sm font-semibold text-gray-800 truncate">
                {mediaPreview.filename || "Preview"}
              </div>
              <button
                type="button"
                onClick={closeMediaPreview}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close preview"
              >
                &#10005;
              </button>
            </div>
            <div className="flex items-center justify-center bg-gray-50 p-6">
              <img
                src={mediaPreview.url}
                alt={mediaPreview.filename || "Preview"}
                className="max-h-[70vh] w-auto max-w-full object-contain"
              />
            </div>
          </div>
        </div>
      )}
      <input
        type="file"
        ref={groupImageInputRef}
        accept="image/*,.html,.htm,text/html"
        multiple
        onChange={handleGroupImageSelection}
        className="hidden"
      />
      <input
        type="file"
        ref={replaceImageInputRef}
        accept="image/*"
        onChange={handleReplaceImageSelection}
        className="hidden"
      />
      <input
        type="file"
        ref={mediaThumbnailInputRef}
        accept="image/*"
        onChange={handleMediaThumbnailSelection}
        className="hidden"
      />
      <HotspotEditor
        isOpen={hotspotEditor.isOpen}
        groupId={hotspotEditor.groupId}
        pages={hotspotEditor.pages}
        initialHotspotsByPage={hotspotEditor.initialHotspotsByPage}
        initialPageId={hotspotEditor.initialPageId}
        onSave={saveHotspotsForGroup}
        onClose={() =>
          setHotspotEditor({
            isOpen: false,
            groupId: "",
            pages: [],
            initialHotspotsByPage: {},
            initialPageId: "",
          })
        }
      />
      <div>
        <Link
          href="/dashboard/products"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          &larr; Back to products
        </Link>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading product details...</div>
      ) : product ? (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">{product.brand}</h2>
              <p className="text-sm text-gray-500 mt-1">{product.category}</p>
            </div>
            <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
              {product.name}
            </span>
          </div>

          {/* Product Card */}
          <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 md:p-6">
            <div className="grid gap-4 md:grid-cols-[minmax(220px,340px)_minmax(0,1fr)] md:items-center">
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                <img
                  src={product.imageDisplay}
                  alt={product.name}
                  onError={(event) => {
                    event.currentTarget.src = FALLBACK_IMAGE;
                  }}
                  className="h-40 w-full object-contain md:h-44"
                />
              </div>
              <div className="space-y-3 text-left">
                <div className="inline-flex border border-blue-300 px-4 py-1.5 text-sm font-semibold text-blue-600">
                  {product.brand}
                </div>
                <div className="text-base font-semibold text-blue-600">{product.name}</div>
                <p className="text-sm leading-relaxed text-gray-600">
                  {product.description}
                </p>
              </div>
            </div>
          </section>

          {/* Edit Product */}
          <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h3 className="text-lg font-semibold text-gray-900">Edit Product</h3>
            <p className="text-sm text-gray-500 mb-4">Update product details or replace media</p>
            <form ref={formRef} className="space-y-4" onSubmit={handleUpdate}>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  name="name"
                  defaultValue={product.name}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Brand</label>
                <input
                  type="text"
                  name="brandName"
                  defaultValue={product.brand}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <input
                  type="text"
                  name="category"
                  defaultValue={product.category}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  rows={4}
                  name="description"
                  defaultValue={product.description}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                ></textarea>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Thumbnail Image</label>
                {product.thumbnailUrl ? (
                  <div className="mb-3 rounded-xl border border-gray-200 bg-white p-2">
                    <img
                      src={product.thumbnailDisplayUrl}
                      alt={`${product.name} thumbnail`}
                      onError={(event) => {
                        event.currentTarget.src = FALLBACK_IMAGE;
                      }}
                      className="h-40 w-full object-contain"
                    />
                  </div>
                ) : null}
                <input
                  type="file"
                  name="thumbnailFile"
                  accept="image/*"
                  ref={thumbnailInputRef}
                  className="block w-full text-sm text-gray-700 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Upload media (images/html/ppt/pptx/pdf)</label>
                <input
                  type="file"
                  multiple
                  accept="image/*,.html,.htm,text/html,.ppt,.pptx,.pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf"
                  onChange={handleMediaChange}
                  ref={mediaInputRef}
                  className="block w-full text-sm text-gray-700 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
                />
                <div className="space-y-3 mt-4">
                  {existingMedia.length > 0 && (
                    <div className="space-y-3">
                      <div className="text-xs font-semibold uppercase text-gray-500">
                        Existing media
                      </div>
                      <div className="text-xs text-gray-400">
                        Drag the <span className="font-semibold">⋮⋮</span> handle to reorder files.
                      </div>
                      <div className="space-y-3">
                        {groupedExistingMedia.map((group) => {
                          const pendingOnly =
                            group.items.length > 0 &&
                            group.items.every(
                              (item) =>
                                item.status === "pending" ||
                                (item.url || "").startsWith("/uploads/queue/")
                            );
                          const headerLabel = group.label;
                          return (
                          <details
                            key={group.key}
                            open={Boolean(expandedMediaGroups[group.key])}
                            onToggle={(event) => {
                              const isOpen = Boolean(event.currentTarget?.open);
                              setExpandedMediaGroups((prev) => ({
                                ...prev,
                                [group.key]: isOpen,
                              }));
                            }}
                            className="rounded-lg border border-gray-200 bg-white"
                          >
                            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gray-700">
                              <span className="truncate">{headerLabel}</span>
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-medium text-gray-400">
                                  {group.items.length} file{group.items.length === 1 ? "" : "s"}
                                </span>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openGroupImagePicker(group);
                                  }}
                                  disabled={isAddingGroupImages}
                                  className="text-xs font-medium text-blue-600 underline disabled:opacity-60"
                                >
                                  {isAddingGroupImages ? "Adding..." : "Add files"}
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const confirmed = window.confirm(
                                      "Remove all media in this group?"
                                    );
                                    if (!confirmed) return;
                                    const urlsToRemove = new Set(
                                      group.items.map((item) => item.url)
                                    );
                                    setExistingMedia((prev) =>
                                      prev.filter((item) => !urlsToRemove.has(item.url))
                                    );
                                  }}
                                  className="text-xs font-medium text-red-600 underline"
                                >
                                  Delete
                                </button>
                              </div>
                            </summary>
                            <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                              <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
                                <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                  Case title
                                </label>
                                <input
                                  type="text"
                                  value={group.groupTitle || group.label}
                                  onChange={(event) => updateGroupTitle(group, event.target.value)}
                                  className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-200"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">
                                  Update the case name here, then click Save Changes.
                                </p>
                              </div>
                              <div className="space-y-2">
                                {pendingOnly ? (
                                  <div className="text-sm text-gray-500">
                                    Converting to images in progress.
                                  </div>
                                ) : (
                                  group.items.map((item) => {
                                    const filename = getFilenameFromUrl(item.url);
                                    const ext = filename.split(".").pop()?.toUpperCase() || "";
                                    const isImage = isImageUrl(filename);
                                    const isHtml =
                                      String(item?.type || "").toLowerCase() === "html" ||
                                      isHtmlFilename(filename);
                                    const hotspotPreviewUrl = getHotspotPreviewUrl(item);
                                    const supportsHotspots = Boolean(hotspotPreviewUrl);
                                    const mediaPreviewUrl = isImage
                                      ? item.displayUrl || ""
                                      : isHtml
                                      ? item.displayThumbnailUrl || ""
                                      : "";
                                    const isDropTarget =
                                      dragOverUrl === item.url &&
                                      draggingMedia?.groupKey === group.key &&
                                      draggingMedia?.url !== item.url;
                                    const isDragging = draggingMedia?.url === item.url;
                                    const isLastEditedHotspotItem =
                                      lastEditedHotspotItemUrl === item.url;
                                    return (
                                      <div
                                        key={item.url}
                                        ref={(node) => {
                                          if (node) {
                                            mediaItemRefs.current.set(item.url, node);
                                            return;
                                          }
                                          mediaItemRefs.current.delete(item.url);
                                        }}
                                        onDragOver={(event) => handleMediaDragOver(event, group, item)}
                                        onDragLeave={(event) => handleMediaDragLeave(event, item)}
                                        onDrop={(event) => handleMediaDrop(event, group, item)}
                                        className={`flex flex-col gap-2 rounded-md border p-3 text-sm text-gray-700 sm:flex-row sm:items-center sm:justify-between ${
                                          isDropTarget
                                            ? "border-blue-300 bg-blue-50/40"
                                          : isLastEditedHotspotItem
                                            ? "border-amber-400 bg-amber-100 ring-4 ring-amber-200 shadow-md transition-all duration-300"
                                            : isDragging
                                            ? "border-blue-200 bg-blue-50/20"
                                            : "border-gray-100"
                                        }`}
                                      >
                                        <div className="flex items-center gap-3">
                                          <span
                                            draggable
                                            onDragStart={(event) => handleMediaDragStart(event, group, item)}
                                            onDragEnd={handleMediaDragEnd}
                                            className="inline-flex cursor-grab select-none items-center rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[11px] font-semibold text-gray-400 active:cursor-grabbing"
                                            title="Drag to reorder"
                                          >
                                            ⋮⋮
                                          </span>
                                          {mediaPreviewUrl && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setMediaPreview({
                                                  isOpen: true,
                                                  url: mediaPreviewUrl,
                                                  filename: isImage ? filename : `${filename} thumbnail`,
                                                })
                                              }
                                              className="h-12 w-12 overflow-hidden rounded border border-gray-200"
                                            >
                                              <img
                                                src={mediaPreviewUrl}
                                                alt={filename}
                                                className="h-full w-full object-cover"
                                              />
                                            </button>
                                          )}
                                          <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                              <div className="truncate" title={filename}>
                                                {filename}
                                              </div>
                                              {isLastEditedHotspotItem && (
                                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                                  Last edited
                                                </span>
                                              )}
                                            </div>
                                            <div className="text-xs text-gray-400">
                                              {ext || "--"}
                                              {item.size ? ` • ${Math.round(item.size / 1024)} KB` : ""}
                                            </div>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {supportsHotspots && (
                                            <button
                                              type="button"
                                              onClick={() => openHotspotEditor(group, item)}
                                              className="cursor-pointer rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700"
                                            >
                                              Hotspot
                                            </button>
                                          )}
                                          {isHtml && !supportsHotspots && (
                                            <button
                                              type="button"
                                              disabled
                                              className="cursor-not-allowed rounded-md border border-gray-200 bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-400"
                                              title="Set a thumbnail first to place hotspots on this HTML slide."
                                            >
                                              Hotspot
                                            </button>
                                          )}
                                          {isImage && (
                                            <button
                                              type="button"
                                              onClick={() => openReplaceImagePicker(item.url)}
                                              disabled={isReplacingImage}
                                              className="cursor-pointer rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                              {isReplacingImage && replaceImageTargetUrl === item.url
                                                ? "Replacing..."
                                                : "Replace image"}
                                            </button>
                                          )}
                                          {isImage && (
                                            <button
                                              type="button"
                                              onClick={() => handleRenameImage(item.url)}
                                              disabled={isRenamingImage}
                                              className="cursor-pointer rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                              {isRenamingImage && renameImageTargetUrl === item.url
                                                ? "Renaming..."
                                                : "Rename"}
                                            </button>
                                          )}
                                          {supportsHotspots && (
                                            <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600">
                                              {getHotspotCount(item)} hotspot
                                              {getHotspotCount(item) === 1 ? "" : "s"}
                                            </span>
                                          )}
                                          {isHtml && (
                                            <button
                                              type="button"
                                              onClick={() => openMediaThumbnailPicker(item.url)}
                                              disabled={isSettingMediaThumbnail}
                                              className="cursor-pointer rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                              {isSettingMediaThumbnail &&
                                              mediaThumbnailTargetUrl === item.url
                                                ? "Saving..."
                                                : item.thumbnailUrl
                                                ? "Change thumbnail"
                                                : "Set thumbnail"}
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => removeExistingMediaItem(item.url)}
                                            className="cursor-pointer rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
                                          >
                                            Delete file
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          </details>
                        );
                        })}
                      </div>
                    </div>
                  )}
                  {mediaFiles.length > 0 && (
                    <div className="space-y-3">
                      <div className="text-xs font-semibold uppercase text-gray-500">
                        New uploads
                      </div>
                      <div className="overflow-hidden rounded-lg border border-gray-200">
                        <table className="w-full text-sm text-gray-700">
                          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold">File</th>
                              <th className="px-3 py-2 text-left font-semibold">Type</th>
                              <th className="px-3 py-2 text-right font-semibold">Size</th>
                              <th className="px-3 py-2 text-right font-semibold">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mediaFiles.map((file) => {
                              const ext = file.name.split(".").pop()?.toUpperCase() || "";
                              return (
                                <tr key={file.name} className="border-t border-gray-100">
                                  <td className="px-3 py-2 truncate" title={file.name}>
                                    {file.name}
                                  </td>
                                  <td className="px-3 py-2">{ext || "--"}</td>
                                  <td className="px-3 py-2 text-right">
                                    {Math.round(file.size / 1024)} KB
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const confirmed = window.confirm("Remove this file?");
                                        if (!confirmed) return;
                                        setMediaFiles((prev) =>
                                          prev.filter((item) => item.name !== file.name)
                                        );
                                      }}
                                      className="text-xs text-blue-600 underline"
                                    >
                                      Remove
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between pt-2">
                <button
                  type="submit"
                  disabled={isUpdating}
                  className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-70"
                >
                  {isUpdating ? "Saving..." : "Save Changes"}
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={handleDelete}
                  className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-100 disabled:opacity-70"
                >
                  {isDeleting ? "Deleting..." : "Delete Product"}
                </button>
              </div>
            </form>
          </section>

        </>
      ) : (
        <div className="text-sm text-gray-500">Product not found.</div>
      )}
    </div>
  );
}
