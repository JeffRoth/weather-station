# Bosque Weather Dashboard

Run the dashboard locally:

```powershell
python server.py
```

Open http://localhost:8000 in a browser. No package installation is required.

The dashboard reads and merges every CSV export in `data/`, converts five-minute observations to daily mean outdoor temperature and daily precipitation, and plots it over a selectable period up to one year. Overlapping timestamps use the newest export. The one-year view uses a Jan 1–Dec 31 calendar axis so each station year can be compared by month and day. Precipitation is always shown as a calendar-year accumulation, resets on January 1, and includes a separate line for each preceding year available in your station export.

Select **Load long-term climate** to retrieve daily Open-Meteo archive data for Santa Fe, NM (35.6870, -105.9378), for the ten preceding years. The dashboard plots the mean plus/minus one standard deviation for matching calendar dates.

Use the layer buttons to independently show or hide the long-term climate band, prior personal-station years, and the selected/current personal-station year. The sigma button switches the climate band between one and two standard deviations.

The **Refresh live data** button polls CWOP ID `GW7633` through the local server. If that upstream report is unavailable or changes format, the chart still uses the saved CSV and continues to work.

To update station history, export a new CSV into the `data` folder. It will be picked up automatically the next time the dashboard loads.
