/** heic-decode 2 ships no types: one HEIC's first image as RGBA. */
declare module 'heic-decode' {
  export interface Decoded {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  export default function decode(input: { buffer: Buffer | ArrayBuffer | Uint8Array }): Promise<Decoded>;
}
