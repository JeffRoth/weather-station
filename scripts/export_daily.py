"""Convert all Ambient CSV exports in data/ into a Worker import payload.

Usage: python scripts/export_daily.py --input data --output cloudflare/import/daily.json
"""
import argparse
import csv
import json
from pathlib import Path


def number(value):
    try:
        return float(value) if value and value.strip() else None
    except ValueError:
        return None


def field(row, phrase):
    return next((value for key, value in row.items() if phrase in key), None)


parser = argparse.ArgumentParser()
parser.add_argument('--input', default='data')
parser.add_argument('--output', required=True)
args = parser.parse_args()

observations = {}
for file in sorted(Path(args.input).glob('*.csv')):
    with file.open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            timestamp = row.get('Date') or row.get('Simple Date')
            if timestamp:
                observations[timestamp] = row

days = {}
for timestamp, row in observations.items():
    date = timestamp[:10]
    entry = days.setdefault(date, {'temperatures': [], 'feels': [], 'rain': 0})
    temperature = number(field(row, 'Outdoor Temperature'))
    feels = number(field(row, 'Feels Like'))
    rain = number(field(row, 'Daily Rain'))
    if temperature is not None:
        entry['temperatures'].append(temperature)
    if feels is not None:
        entry['feels'].append(feels)
    if rain is not None:
        entry['rain'] = max(entry['rain'], rain)

daily = []
for date, values in sorted(days.items()):
    if not values['temperatures']:
        continue
    daily.append({
        'date': date,
        'temperature': sum(values['temperatures']) / len(values['temperatures']),
        'highTemperature': max(values['temperatures']),
        'lowTemperature': min(values['temperatures']),
        'feelsLike': sum(values['feels']) / len(values['feels']) if values['feels'] else None,
        'precipitation': values['rain'],
    })

output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'daily': daily}), encoding='utf-8')
print(f'Wrote {len(daily)} daily records to {output}')
