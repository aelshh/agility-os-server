declare module "mammoth" {
  export interface RawTextResult {
    value: string;
    messages: Array<{
      type: "warning" | "error";
      message: string;
    }>;
  }

  export function extractRawText(input: {
    buffer: Buffer;
  }): Promise<RawTextResult>;

  export function extractRawText(input: {
    path: string;
  }): Promise<RawTextResult>;
}