/** HEIC and HEIF photos, which Sharp's prebuilt libvips can't read. libheif in
 * WebAssembly decodes them, the right way up, for the JPEGs made from them: the
 * book's photos, thumbnails, and the copy sent to be described. It loads on
 * first use, so work with no HEIC doesn't pay for it. */
export const HEIF = new Set(['image/heic', 'image/heif']);
export interface Pixels {
  width: number;
  height: number;
  /** RGBA, four channels. */
  data: Buffer;
}
export async function decodeHeif(bytes: Buffer, maxPixels: number): Promise<Pixels | null> {
  const decode = (await import('heic-decode')).default,
    image = await decode({ buffer: bytes });
  if (!image.width || !image.height || image.width * image.height > maxPixels) return null;
  return {
    width: image.width,
    height: image.height,
    data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  };
}
/** A 16 by 16 pixel HEIC (a synthetic gradient, made with macOS sips), so
 * the deploy probes prove libheif decodes on Lambda. */
export const TINY_HEIC =
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA' +
  'AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVp' +
  'bmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADF' +
  'aXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAQAAAAEAAAAAlpcm90AAAAABBwaXhpAAAA' +
  'AAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AA' +
  'AAMAsAAAAwAAAwAeoBQgQcCTDOIe5FlU3AgIGAKiAAEACUQBwGFyyEBTJAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxv' +
  'YwAAAABEAAACAAEAAAABAAACQwAAAGQAAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAMAAAAAGRXhpZgAATU0AKgAAAAgAAwEa' +
  'AAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAYCgBr6N9Rn0chlK+NxX5fNSO' +
  'uobktpkUDShsfhEKWtPaiHClObduCXXPkzLF9AZ7RlaYWBjA/00dH/94hf/rWZI9o/P9FR9lt8ZYnX9T2n1PbE4sxNXf9Y39dUgQ' +
  't34UFw==';
