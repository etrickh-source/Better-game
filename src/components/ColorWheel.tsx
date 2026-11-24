import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

interface ColorWheelProps {
  color: string;
  onChange: (hex: string) => void;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0'))
      .join('')
  );
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return { h: 0, s: 0, v: 1 };
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function ColorWheel({ color, onChange }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const [hsv, setHsv] = useState(() => hexToHsv(color));

  useEffect(() => {
    setHsv(hexToHsv(color));
  }, [color]);

  // Draw circular HSV wheel for current brightness V
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = canvas.width;
    const radius = size / 2;
    const img = ctx.createImageData(size, size);
    const data = img.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - radius;
        const dy = y - radius;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * size + x) * 4;

        if (dist <= radius) {
          const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          const sat = Math.min(1, dist / radius);
          const [r, g, b] = hsvToRgb(angle, sat, hsv.v);
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = dist > radius - 1.2 ? Math.max(0, Math.round((radius - dist) * 210)) : 255;
        } else {
          data[idx + 3] = 0;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [hsv.v]);

  const pickAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.min(radius, Math.sqrt(dx * dx + dy * dy));
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const s = dist / radius;
    const next = { h, s, v: hsv.v };
    setHsv(next);
    const [r, g, b] = hsvToRgb(next.h, next.s, next.v);
    onChange(rgbToHex(r, g, b));
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    pickAt(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    pickAt(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const markerAngle = (hsv.h * Math.PI) / 180;
  const markerRadiusPct = hsv.s * 50;
  const markerLeftPct = 50 + Math.cos(markerAngle) * markerRadiusPct;
  const markerTopPct = 50 + Math.sin(markerAngle) * markerRadiusPct;

  return (
    <div className="flex items-center gap-3.5">
      <div className="relative h-28 w-28 shrink-0 select-none">
        <canvas
          ref={canvasRef}
          width={112}
          height={112}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="h-full w-full rounded-full cursor-crosshair touch-none shadow-inner"
          aria-label="Texture Color Wheel"
        />
        <div
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{
            left: `${markerLeftPct}%`,
            top: `${markerTopPct}%`,
            backgroundColor: color,
          }}
        />
      </div>

      <div className="flex-1 space-y-2">
        <div>
          <div className="flex items-center justify-between text-xs font-medium text-slate-700">
            <span>Tint Shade</span>
            <span className="font-mono-tabular text-slate-900">{Math.round(hsv.v * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.02}
            value={hsv.v}
            onChange={(e) => {
              const v = Number(e.target.value);
              const next = { ...hsv, v };
              setHsv(next);
              const [r, g, b] = hsvToRgb(next.h, next.s, next.v);
              onChange(rgbToHex(r, g, b));
            }}
            className="mt-1 w-full accent-sky-600 cursor-pointer"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-5 w-5 rounded border border-slate-300"
              style={{ backgroundColor: color }}
            />
            <span className="text-xs font-mono-tabular uppercase text-slate-700">{color}</span>
          </div>

          <button
            type="button"
            onClick={() => onChange('#ffffff')}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Original
          </button>
        </div>
      </div>
    </div>
  );
}
