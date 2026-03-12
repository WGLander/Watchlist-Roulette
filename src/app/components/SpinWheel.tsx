"use client";

import { useRef, useEffect, useState, useCallback } from "react";

// Letterboxd-inspired color palette for wheel segments
const SEGMENT_COLORS = [
  "#60d5f4",
  "#40bcf4",
  "#ff8000",
  "#e64c66",
  "#a366ff",
  "#29b8db",
  "#f5c518",
  "#ee7752",
  "#7dd3fc",
  "#d170e0",
  "#4a90d9",
  "#ff6b6b",
  "#38bdf8",
  "#fd7e14",
  "#6f42c1",
  "#17a2b8",
];

interface SpinWheelProps {
  items: string[];
  onResult: (item: string) => void;
}

export default function SpinWheel({ items, onResult }: SpinWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [spinning, setSpinning] = useState(false);
  const rotationRef = useRef(0);
  const animFrameRef = useRef<number>(0);
  const [maxSize, setMaxSize] = useState(0);
  const dprRef = useRef(1);

  // Scale wheel size up for large lists so segments stay legible
  const baseSize = 420;
  const desiredSize = items.length > 60 ? 520 : items.length > 30 ? 470 : baseSize;
  const size = Math.min(desiredSize, maxSize || desiredSize);
  const center = size / 2;
  const radius = size / 2 - 8;

  const displayItems = items;
  const segAngle = displayItems.length > 0 ? (2 * Math.PI) / displayItems.length : 0;

  const drawWheel = useCallback(
    (rot: number) => {
      const canvas = canvasRef.current;
      const staticCanvas = staticCanvasRef.current;
      if (!canvas || !staticCanvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = dprRef.current || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      ctx.save();
      ctx.translate(center, center);
      ctx.rotate(rot);
      ctx.drawImage(staticCanvas, -center, -center, size, size);
      ctx.restore();

      // Pointer (triangle at right side, pointing left)
      const pointerX = size - 2;
      const pointerY = center;
      ctx.beginPath();
      ctx.moveTo(pointerX, pointerY - 14);
      ctx.lineTo(pointerX - 24, pointerY);
      ctx.lineTo(pointerX, pointerY + 14);
      ctx.closePath();
      ctx.fillStyle = "#1a1a2e";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    },
    [center, size],
  );

  useEffect(() => {
    if (displayItems.length === 0 || segAngle === 0) return;

    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    }

    const staticCanvas =
      staticCanvasRef.current || document.createElement("canvas");
    staticCanvasRef.current = staticCanvas;
    staticCanvas.width = size * dpr;
    staticCanvas.height = size * dpr;

    const ctx = staticCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Draw static wheel once (segments + text + center)
    const segmentCount = displayItems.length;
    const borderWidth =
      segmentCount > 120 ? 0.2 : segmentCount > 80 ? 0.4 : segmentCount > 40 ? 0.8 : 1.5;
    const borderAlpha =
      segmentCount > 120 ? 0.25 : segmentCount > 80 ? 0.35 : segmentCount > 40 ? 0.5 : 1;

    for (let i = 0; i < displayItems.length; i++) {
      const startAngle = i * segAngle;
      const endAngle = startAngle + segAngle;

      // Segment fill
      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.arc(center, center, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
      ctx.fill();

      // Segment border (fade/thin for large lists to avoid washing out colors)
      ctx.strokeStyle = `rgba(255, 255, 255, ${borderAlpha})`;
      ctx.lineWidth = borderWidth;
      ctx.stroke();

      // Text
      ctx.save();
      ctx.translate(center, center);
      ctx.rotate(startAngle + segAngle / 2);

      // Dynamic font size: shrinks as segment count grows
      const fontSize = Math.max(5, Math.min(12, (segAngle * radius) / 2.2));
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      // Truncate label based on available arc space
      const maxChars = Math.max(
        4,
        Math.floor((radius * 0.75) / (fontSize * 0.55)),
      );
      const raw = displayItems[i];
      const label =
        raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;
      ctx.fillText(label, radius - 10, 0);

      ctx.restore();
    }

    // Center circle
    ctx.beginPath();
    ctx.arc(center, center, 22, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(center, center, 18, 0, 2 * Math.PI);
    ctx.fillStyle = "#f0f0f0";
    ctx.fill();

    drawWheel(rotationRef.current);
  }, [displayItems, segAngle, center, radius, size, drawWheel]);

  useEffect(() => {
    function updateMaxSize() {
      const width = window.innerWidth;
      const available = Math.floor(width - 32);
      setMaxSize(Math.max(0, available));
    }

    updateMaxSize();
    window.addEventListener("resize", updateMaxSize);
    return () => window.removeEventListener("resize", updateMaxSize);
  }, []);

  function spin() {
    if (spinning || displayItems.length === 0) return;
    setSpinning(true);

    // Random spin: 5-10 full rotations + random offset
    const extraRotations = (5 + Math.random() * 5) * 2 * Math.PI;
    const randomOffset = Math.random() * 2 * Math.PI;
    const totalSpin = extraRotations + randomOffset;
    const startRot = rotationRef.current;
    const targetRot = startRot - totalSpin; // spin clockwise (negative = CW visually)

    const duration = 4000 + Math.random() * 1000; // 4-5s
    const startTime = performance.now();

    function easeOutCubic(t: number) {
      return 1 - Math.pow(1 - t, 3);
    }

    function animate(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(t);
      const currentRot = startRot + (targetRot - startRot) * eased;

      rotationRef.current = currentRot;
      drawWheel(currentRot);

      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        setSpinning(false);

        // Determine which segment the pointer lands on
        // Pointer is at angle 0 (right side / 3 o'clock)
        const normalizedRot =
          ((-currentRot % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const idx = Math.floor(normalizedRot / segAngle) % displayItems.length;
        onResult(displayItems[idx]);
      }
    }

    animFrameRef.current = requestAnimationFrame(animate);
  }

  // Cleanup
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative">
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size }}
          className="rounded-full shadow-lg shadow-black/10"
        />
      </div>
      <button
        onClick={spin}
        disabled={spinning || displayItems.length === 0}
        className="px-8 py-3 rounded-lg bg-accent text-accent-foreground font-bold text-base hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {spinning ? "Spinning..." : "Spin!"}
      </button>
    </div>
  );
}
