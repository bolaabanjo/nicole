import pdfParse from "pdf-parse";
import fs from "fs/promises";

export async function parsePdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text.trim();
}
