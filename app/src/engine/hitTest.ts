import { Container, Graphics, Sprite, Texture, type TextureSource } from 'pixi.js';

/** Alpha channel of each sprite sheet, read once on first use (null when the pixels can't be read). */
const alphaCache = new WeakMap<TextureSource, Uint8ClampedArray | null>();

function alphaData(source: TextureSource): Uint8ClampedArray | null {
  if (alphaCache.has(source)) return alphaCache.get(source)!;
  let data: Uint8ClampedArray | null = null;
  const resource = source.resource as CanvasImageSource | undefined;
  const width = source.pixelWidth;
  const height = source.pixelHeight;
  if (resource && width > 0 && height > 0) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(resource, 0, 0);
        data = ctx.getImageData(0, 0, width, height).data;
      }
    } catch {
      data = null; // unreadable (e.g. tainted): treat the sprite as solid
    }
  }
  alphaCache.set(source, data);
  return data;
}

/** Is the stage point on an opaque pixel of this sprite? */
function spriteHit(sprite: Sprite, x: number, y: number): boolean {
  const texture = sprite.texture;
  if (!texture || texture === Texture.EMPTY) return false;
  const local = sprite.toLocal({ x, y });
  const { width, height } = texture.frame;
  const lx = local.x + sprite.anchor.x * width;
  const ly = local.y + sprite.anchor.y * height;
  if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
  const data = alphaData(texture.source);
  if (!data) return true;
  const px = Math.floor(texture.frame.x + lx);
  const py = Math.floor(texture.frame.y + ly);
  return data[(py * texture.source.pixelWidth + px) * 4 + 3] > 0;
}

/**
 * Pixel-accurate hit test for a display object's view: true when the stage
 * point is on an opaque pixel of a visible sprite in it. Graphics and text
 * count as solid rectangles (hotspots are transparent rectangles).
 */
export function viewHit(container: Container, x: number, y: number): boolean {
  for (let i = container.children.length - 1; i >= 0; i--) {
    const child = container.children[i];
    if (!child.visible || child.alpha === 0) continue;
    if (child instanceof Sprite) {
      if (spriteHit(child, x, y)) return true;
    } else if (child instanceof Graphics || child.children.length === 0) {
      const b = child.getBounds();
      if (x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY) return true;
    } else if (viewHit(child, x, y)) {
      return true;
    }
  }
  return false;
}
