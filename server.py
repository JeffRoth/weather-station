"""Local server for the weather dashboard.

Run: python server.py
Then open http://localhost:8000
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from pathlib import Path
import json
import re


class DashboardHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/cwop":
            station = parse_qs(parsed.query).get("station", ["GW7633"])[0]
            self.send_cwop(station)
            return
        if parsed.path == "/api/station-files":
            files = sorted(Path("data").glob("*.csv"))
            self.send_json({"files": [f"data/{file.name}" for file in files]})
            return
        return super().do_GET()

    def send_cwop(self, station):
        # findU publishes CWOP packets without requiring an API key.  This local
        # proxy avoids browser CORS restrictions; it deliberately returns only
        # the small set of values needed by the dashboard.
        try:
            url = "https://www.findu.com/cgi-bin/wxpage.cgi?call=" + station
            request = Request(url, headers={"User-Agent": "WeatherDashboard/1.0"})
            html = urlopen(request, timeout=12).read().decode("utf-8", "ignore")
            def value(pattern):
                found = re.search(pattern, html, re.I | re.S)
                return float(found.group(1)) if found else None
            payload = {
                "station": station,
                "temperatureF": value(r"(?:temperature|temp)[^0-9-]{0,80}(-?\d+(?:\.\d+)?)\s*(?:&deg;|°|F)"),
                "rain24hIn": value(r"(?:rain[^<]{0,50}(?:24|last day)|24[^<]{0,50}rain)[^0-9]{0,80}(\d+(?:\.\d+)?)"),
                "source": "CWOP / findU",
            }
            self.send_json(payload)
        except Exception as error:
            self.send_json({"station": station, "error": str(error)}, 502)

    def send_json(self, data, status=200):
        encoded = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    print("Weather dashboard: http://localhost:8000")
    ThreadingHTTPServer(("", 8000), DashboardHandler).serve_forever()
