import Cencori from "cencori";

let cachedClient: Cencori | null = null;

export function getCencoriClient(): Cencori {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.CENCORI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CENCORI_API_KEY is not configured. Set it or switch Nicole chat to a local provider."
    );
  }

  cachedClient = new Cencori({ apiKey });
  return cachedClient;
}
