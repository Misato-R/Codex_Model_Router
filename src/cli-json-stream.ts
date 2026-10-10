/** Decode JSON objects without treating legal U+2028/U+2029 string characters as record separators. */
export class JsonObjectStream {
  private parts: string[] = [];
  private size = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  constructor(private readonly emit: (value: Record<string, any>) => void, private readonly maxLength = 32 * 1024 * 1024) {}
  push(chunk: string): void {
    let start = this.depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (!this.depth) {
        if (/\s/.test(c)) continue;
        if (c !== "{") throw new Error("Expected JSON object");
        start = i; this.depth = 1;
      } else if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.quoted = false;
      } else if (c === '"') this.quoted = true;
      else if (c === "{" || c === "[") this.depth++;
      else if (c === "}" || c === "]") {
        this.depth--;
        if (!this.depth) {
          this.append(chunk.slice(start, i + 1));
          const value = JSON.parse(this.parts.join(""));
          this.parts = []; this.size = 0; start = -1;
          this.emit(value);
        }
      }
    }
    if (start >= 0) this.append(chunk.slice(start));
  }
  private append(part: string): void {
    this.size += part.length;
    if (this.size > this.maxLength) throw new Error("JSON response too large");
    this.parts.push(part);
  }
}
