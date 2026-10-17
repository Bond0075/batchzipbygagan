// Minimal local type declaration for archiver v8 (ships without types,
// and @types/archiver targets the old v6 API).
declare module "archiver" {
  import { Transform } from "node:stream";
  export interface ZipOptions {
    zlib?: { level?: number };
    comment?: string;
  }
  export interface EntryData {
    name?: string;
    prefix?: string;
  }
  export class ZipArchive extends Transform {
    constructor(options?: ZipOptions);
    pipe<T extends NodeJS.WritableStream>(dest: T): T;
    file(filepath: string, data?: EntryData): this;
    append(source: string | Buffer | NodeJS.ReadableStream, data?: EntryData): this;
    finalize(): Promise<void>;
    pointer(): number;
  }
}
