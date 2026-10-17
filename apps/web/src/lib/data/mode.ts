/** VITE_FEED=mock|http. Varsayılan mock: gerçek uç noktalar (PLANLI) hazır olana kadar. */
export const feedMode: "mock" | "http" = import.meta.env.VITE_FEED === "http" ? "http" : "mock";

/** Mock beslemeler açıkken ekranda TEMSİLİ VERİ rozeti görünür. */
export const isMockFeed = feedMode === "mock";
