# Root Record Weather Manager

Desktop app (Electron) for location-specific NOAA alerts and USGS earthquake data.

## Core Rule

Users must complete setup and save at least one location before the app can fetch any external data.

## Run

1. `npm install`
2. `npm start`

## Data Sources

- NOAA alerts: `https://api.weather.gov/alerts/active`
- USGS earthquakes: `https://earthquake.usgs.gov/fdsnws/event/1/query`
