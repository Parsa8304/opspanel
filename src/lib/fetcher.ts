export const fetcher = async (url: string) => {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) {
    const e: any = new Error("Request failed");
    e.status = r.status;
    try {
      e.info = await r.json();
    } catch {}
    throw e;
  }
  return r.json();
};
