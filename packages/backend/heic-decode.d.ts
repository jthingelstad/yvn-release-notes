/** heic-decode 2 ships no types: one HEIC's first image as RGBA, or `all`, each
 * image's size read from the file with its pixels decoded only when asked. */
declare module 'heic-decode' {
  export interface Decoded {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  export interface Image {
    width: number;
    height: number;
    decode(): Promise<Decoded>;
  }
  type Input = { buffer: Buffer | ArrayBuffer | Uint8Array };
  function decode(input: Input): Promise<Decoded>;
  namespace decode {
    function all(input: Input): Promise<Image[] & { dispose(): void }>;
  }
  export default decode;
}
