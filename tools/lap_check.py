"""Independent lap-time checker (Python), used to cross-check the app's JavaScript lap engine.

Reads the GPS rows (kind L) of a session CSV in the TrackLogger / Sepang Lap Timer format and times
laps across a start/finish line given as centre latitude, longitude, direction of travel (degrees
from true north) and half-width in metres.

Usage:
    python tools/lap_check.py SESSION.csv --line LAT,LON,HEADING[,HALFWIDTH] [--min-lap 60]
    python tools/lap_check.py SESSION.csv --line ... --sweep-east 0.0001 --steps 40   (move the line along the straight)

It is deliberately written separately from js/lapengine.js so the two can check each other.
"""
import argparse
import math
import statistics

WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3


def read_fixes(path):
    fixes = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if not line.startswith('L,'):
                continue
            p = line.strip().split(',')
            if len(p) < 12:
                continue  # truncated row
            try:
                t = int(p[1]) / 1e6
                lat, lon, v = float(p[2]), float(p[3]), float(p[5])
            except ValueError:
                continue
            fixes.append((t, lat, lon, v))
    fixes.sort(key=lambda r: r[0])
    out = []
    for r in fixes:
        if out and r[0] <= out[-1][0]:
            continue
        out.append(r)
    return out


class Projection:
    def __init__(self, lat0, lon0):
        s = math.sin(math.radians(lat0))
        self.lat0, self.lon0 = lat0, lon0
        self.m = WGS84_A * (1 - WGS84_E2) / (1 - WGS84_E2 * s * s) ** 1.5
        self.n = WGS84_A / math.sqrt(1 - WGS84_E2 * s * s) * math.cos(math.radians(lat0))

    def xy(self, lat, lon):
        return math.radians(lon - self.lon0) * self.n, math.radians(lat - self.lat0) * self.m


def crossing_time(t0, t1, v0, v1, u):
    """Time at fraction u of the chord, assuming constant acceleration between the fixes."""
    dt = t1 - t0
    if v0 is None or v1 is None or v0 < 0 or v1 < 0 or v0 + v1 < 0.5:
        return t0 + u * dt
    acc = (v1 - v0) / dt
    dist = u * (v0 + v1) * dt / 2
    if abs(acc) < 1e-6:
        tau = dist / v0 if v0 > 0 else u * dt
    else:
        disc = v0 * v0 + 2 * acc * dist
        tau = (-v0 + math.sqrt(max(disc, 0.0))) / acc
    return t0 + min(max(tau, 0.0), dt)


def time_laps(fixes, lat, lon, heading, half_width=25.0, min_lap=60.0):
    proj = Projection(lat, lon)
    h = math.radians(heading)
    nx, ny = math.sin(h), math.cos(h)          # direction of travel (east, north)
    tx, ty = math.cos(h), -math.sin(h)         # along the line, to the driver's right
    ax, ay = -half_width * tx, -half_width * ty
    bx, by = half_width * tx, half_width * ty
    crossings = []
    prev = None
    for t, la, lo, v in fixes:
        x, y = proj.xy(la, lo)
        if prev is not None:
            pt, px, py, pv = prev
            rx, ry = x - px, y - py
            sx, sy = bx - ax, by - ay
            den = rx * sy - ry * sx
            if abs(den) > 1e-9 and rx * nx + ry * ny > 0:
                qx, qy = ax - px, ay - py
                u = (qx * sy - qy * sx) / den
                w = (qx * ry - qy * rx) / den
                if 0 < u <= 1 and 0 <= w <= 1:
                    tc = crossing_time(pt, t, pv, v, u)
                    if not crossings or tc - crossings[-1] >= min_lap:
                        crossings.append(tc)
        prev = (t, x, y, v)
    laps = [b - a for a, b in zip(crossings, crossings[1:])]
    return crossings, laps


def fmt(sec):
    m = int(sec // 60)
    return '%d:%06.3f' % (m, sec - 60 * m)


def all_crossings(fixes, lat, lon, heading, half_width):
    """Every crossing of a line in its direction of travel (no minimum time between them)."""
    c, _ = time_laps(fixes, lat, lon, heading, half_width, 0.0)
    return c


def parse_line(text, default_hw=25.0):
    parts = [float(x) for x in text.split(',')]
    return parts[0], parts[1], parts[2], (parts[3] if len(parts) > 3 else default_hw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('--line', required=True, help='LAT,LON,HEADING[,HALFWIDTH]')
    ap.add_argument('--split', action='append', default=[], help='sector line LAT,LON,HEADING[,HALFWIDTH]; repeat for each')
    ap.add_argument('--json', help='also write the results to this JSON file (keep it in data/, never in git)')
    ap.add_argument('--min-lap', type=float, default=60.0)
    ap.add_argument('--sweep-east', type=float, default=0.0, help='longitude step for a sweep')
    ap.add_argument('--steps', type=int, default=0)
    a = ap.parse_args()
    lat, lon, hdg, hw = parse_line(a.line)
    fixes = read_fixes(a.csv)
    if a.json:
        import json
        crossings, laps = time_laps(fixes, lat, lon, hdg, hw, a.min_lap)
        splits = [all_crossings(fixes, *parse_line(s)) for s in a.split]
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump({'fixes': len(fixes), 'crossings': crossings, 'laps': laps, 'splitCrossings': splits}, f)
        print('wrote', a.json)
    if a.steps:
        for k in range(a.steps + 1):
            lo = lon + k * a.sweep_east
            c, laps = time_laps(fixes, lat, lo, hdg, hw, a.min_lap)
            if laps:
                print('lon %.5f  laps %2d  best %s  median %s' % (lo, len(laps), fmt(min(laps)), fmt(statistics.median(laps))))
            else:
                print('lon %.5f  no laps' % lo)
        return
    crossings, laps = time_laps(fixes, lat, lon, hdg, hw, a.min_lap)
    print('fixes %d, crossings %d, laps %d' % (len(fixes), len(crossings), len(laps)))
    for i, x in enumerate(laps, 1):
        print('lap %2d  %s  (crossed at t=%.3f s)' % (i, fmt(x), crossings[i]))
    if laps:
        print('best %s (lap %d)  median %s' % (fmt(min(laps)), laps.index(min(laps)) + 1, fmt(statistics.median(laps))))


if __name__ == '__main__':
    main()
