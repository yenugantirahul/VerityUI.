export const tileSize = 16;
const maxRegions = 24;

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  changedPixels: number;
}

interface Tile {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
}

function mergeBounds(target: Tile, other: Tile) {
  target.left = Math.min(target.left, other.left);
  target.top = Math.min(target.top, other.top);
  target.right = Math.max(target.right, other.right);
  target.bottom = Math.max(target.bottom, other.bottom);
  target.count += other.count;
}

export function locateRegions(mask: Buffer, width: number, height: number) {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tiles: (Tile | undefined)[] = Array(columns * rows).fill(undefined);

  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / tileSize) * columns;
    for (let x = 0; x < width; x++) {
      if (!mask[(y * width + x) * 4 + 3]) continue;
      const index = row + Math.floor(x / tileSize);
      const tile = tiles[index];
      if (tile) {
        tile.left = Math.min(tile.left, x);
        tile.right = Math.max(tile.right, x);
        tile.bottom = y;
        tile.count++;
      } else {
        tiles[index] = { left: x, right: x, top: y, bottom: y, count: 1 };
      }
    }
  }

  const visited = new Uint8Array(tiles.length);
  const regions: Region[] = [];
  for (let index = 0; index < tiles.length; index++) {
    const start = tiles[index];
    if (!start || visited[index]) continue;
    const region = { ...start };
    const queue = [index];
    visited[index] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!;
      const column = current % columns;
      const row = Math.floor(current / columns);
      for (
        let y = Math.max(0, row - 1);
        y <= Math.min(rows - 1, row + 1);
        y++
      ) {
        for (
          let x = Math.max(0, column - 1);
          x <= Math.min(columns - 1, column + 1);
          x++
        ) {
          const neighbor = y * columns + x;
          const tile = tiles[neighbor];
          if (!tile || visited[neighbor]) continue;
          visited[neighbor] = 1;
          mergeBounds(region, tile);
          queue.push(neighbor);
        }
      }
    }
    regions.push({
      x: region.left,
      y: region.top,
      width: region.right - region.left + 1,
      height: region.bottom - region.top + 1,
      changedPixels: region.count,
    });
  }
  regions.sort(
    (a, b) => b.changedPixels - a.changedPixels || a.y - b.y || a.x - b.x,
  );
  return {
    regions: regions.slice(0, maxRegions),
    omittedRegions: Math.max(0, regions.length - maxRegions),
    tiles: tiles.map((tile) => tile?.count ?? 0),
    columns,
  };
}
