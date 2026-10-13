import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardStats,
  formatBoardPrice,
  formatChange,
  formatVolume,
  sortBoard,
  SPARKLINE_POINTS,
} from "./market-board.ts";

const HOUR = 3600;
const NOW = 1_000_000;

const candle = (hoursAgo, open, close, volume = 1, trades = 1) => ({
  time: NOW - hoursAgo * HOUR,
  open,
  close,
  volume,
  trades,
});

test("a project that has not traded has no figures, not zeros", () => {
  assert.equal(boardStats([], NOW), null);
  assert.equal(
    boardStats([candle(1, 1, 1, 5, 0)], NOW),
    null,
    "a candle with no trades is not a trade",
  );
  assert.equal(
    boardStats([candle(1, 0, 0, 5, 3)], NOW),
    null,
    "no usable price",
  );
});

test("the price is the last traded close, and the move is measured from the last price at or before 24 hours ago", () => {
  const stats = boardStats(
    [
      candle(30, 1.0, 1.0),
      candle(26, 1.0, 1.5),
      candle(5, 1.5, 1.8),
      candle(1, 1.8, 3.0),
    ],
    NOW,
  );
  assert.equal(stats.price, 3.0);
  // The reference is the close of the newest candle that started before the 24-hour mark (1.5).
  assert.equal(stats.change24h, (3.0 - 1.5) / 1.5);
  assert.equal(stats.lastTradeAt, NOW - 1 * HOUR);
});

test("a market under a day old is measured from its first trade", () => {
  const stats = boardStats([candle(10, 2.0, 2.2), candle(2, 2.2, 3.0)], NOW);
  assert.equal(stats.change24h, (3.0 - 2.0) / 2.0);
});

test("a single trade with no move says zero, and a fall is negative", () => {
  assert.equal(boardStats([candle(1, 2.0, 2.0)], NOW).change24h, 0);
  assert.ok(boardStats([candle(30, 4, 4), candle(1, 4, 3)], NOW).change24h < 0);
});

test("only the last 24 hours count towards volume", () => {
  const stats = boardStats(
    [
      candle(40, 1, 1, 100),
      candle(25, 1, 1, 100),
      candle(23, 1, 1, 7),
      candle(1, 1, 1, 5),
    ],
    NOW,
  );
  assert.equal(stats.volume24h, 12);
});

test("the small chart keeps the latest closes, oldest first", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    candle(40 - i, 1 + i, 1 + i),
  );
  const stats = boardStats(many, NOW);
  assert.equal(stats.points.length, SPARKLINE_POINTS);
  assert.equal(stats.points[stats.points.length - 1], 40);
  assert.ok(stats.points[0] < stats.points[1]);
});

test("candles may arrive in any order", () => {
  const a = boardStats(
    [candle(1, 1, 2), candle(30, 1, 1), candle(5, 1, 1.5)],
    NOW,
  );
  const b = boardStats(
    [candle(30, 1, 1), candle(5, 1, 1.5), candle(1, 1, 2)],
    NOW,
  );
  assert.deepEqual(a, b);
});

const row = (name, stats, createdAt) => ({ name, stats, createdAt });
const figures = (volume24h, change24h) => ({
  price: 1,
  change24h,
  volume24h,
  points: [1],
  lastTradeAt: 0,
});

test("the board sorts by volume, by the size of the move, or by newest, and projects without figures always come last", () => {
  const rows = [
    row("quiet", null, 300),
    row("big", figures(900, 0.01), 100),
    row("mover", figures(10, -0.5), 200),
    row("small", figures(50, 0.1), 50),
  ];
  assert.deepEqual(
    sortBoard(rows, "volume").map((r) => r.name),
    ["big", "small", "mover", "quiet"],
  );
  assert.deepEqual(
    sortBoard(rows, "change").map((r) => r.name),
    ["mover", "small", "big", "quiet"],
  );
  assert.deepEqual(
    sortBoard(rows, "newest").map((r) => r.name),
    ["quiet", "mover", "big", "small"],
  );
});

test("sorting does not change the rows it is given", () => {
  const rows = [row("a", figures(1, 0), 1), row("b", figures(2, 0), 2)];
  const copy = [...rows];
  sortBoard(rows, "volume");
  assert.deepEqual(rows, copy);
});

test("moves, prices and volumes are written plainly", () => {
  assert.equal(formatChange(0.1234), "+12.3%");
  assert.equal(formatChange(-0.04), "−4.0%");
  assert.equal(formatChange(0), "0.0%");
  assert.equal(formatChange(0.0001), "0.0%");
  assert.equal(formatChange(null), "–");
  assert.equal(formatChange(Number.NaN), "–");

  assert.equal(formatBoardPrice(0.000123456), "0.000123");
  assert.equal(formatBoardPrice(0.5), "0.500");
  assert.equal(formatBoardPrice(12.345), "12.35");
  assert.equal(formatBoardPrice(12345.6), "12346");
  assert.equal(formatBoardPrice(0), "–");

  assert.equal(formatVolume(0), "0");
  assert.equal(formatVolume(3.456), "3.5");
  assert.equal(formatVolume(250), "250");
  assert.equal(formatVolume(1234), "1.2k");
  assert.equal(formatVolume(3_400_000), "3.4M");
});
