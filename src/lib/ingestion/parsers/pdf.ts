import * as pdfParse from "pdf-parse";
import fs from "fs/promises";

export async function parsePdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const parse = (pdfParse as any).default || pdfParse;
  const data = await parse(buffer);
  return data.text.trim();
}
