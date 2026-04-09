/**
 * Weather integration using Open-Meteo (free, no API key required).
 * Fits Nicole's fully-local, no-cloud-dependency philosophy.
 *
 * Uses geocoding to resolve city names, then fetches current conditions
 * and a short forecast.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherConditions {
  location: string;
  latitude: number;
  longitude: number;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  weatherCode: number;
  weatherDescription: string;
  isDay: boolean;
  precipitation: number;
  cloudCover: number;
  uvIndex: number;
}

export interface DailyForecast {
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  weatherCode: number;
  weatherDescription: string;
  precipitationProbability: number;
  windSpeedMax: number;
  uvIndexMax: number;
  sunrise: string;
  sunset: string;
}

export interface WeatherResult {
  current: WeatherConditions;
  forecast: DailyForecast[];
  timezone: string;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// WMO weather code descriptions
// ---------------------------------------------------------------------------

const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code: number): string {
  return WMO_CODES[code] || "Unknown";
}

// ---------------------------------------------------------------------------
// Geocoding — resolve a location name to coordinates
// ---------------------------------------------------------------------------

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;
  timezone: string;
}

async function geocode(location: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;

  const r = data.results[0];
  return {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country || "",
    admin1: r.admin1,
    timezone: r.timezone || "auto",
  };
}

// ---------------------------------------------------------------------------
// Default location (used when no location specified)
// ---------------------------------------------------------------------------

const DEFAULT_LOCATION = {
  name: "London",
  latitude: 51.5074,
  longitude: -0.1278,
  country: "United Kingdom",
  timezone: "Europe/London",
};

// ---------------------------------------------------------------------------
// Fetch weather from Open-Meteo
// ---------------------------------------------------------------------------

export async function getWeather(
  location?: string,
  forecastDays: number = 3
): Promise<WeatherResult> {
  let geo: GeoResult;

  if (location) {
    const resolved = await geocode(location);
    if (!resolved) {
      throw new Error(`Could not find location: "${location}"`);
    }
    geo = resolved;
  } else {
    geo = DEFAULT_LOCATION;
  }

  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "wind_speed_10m",
      "wind_direction_10m",
      "weather_code",
      "is_day",
      "precipitation",
      "cloud_cover",
      "uv_index",
    ].join(","),
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "weather_code",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "uv_index_max",
      "sunrise",
      "sunset",
    ].join(","),
    timezone: geo.timezone,
    forecast_days: String(Math.min(forecastDays, 7)),
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const locationLabel = geo.admin1
    ? `${geo.name}, ${geo.admin1}, ${geo.country}`
    : `${geo.name}, ${geo.country}`;

  const current: WeatherConditions = {
    location: locationLabel,
    latitude: geo.latitude,
    longitude: geo.longitude,
    temperature: data.current.temperature_2m,
    feelsLike: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    windDirection: data.current.wind_direction_10m,
    weatherCode: data.current.weather_code,
    weatherDescription: describeWeatherCode(data.current.weather_code),
    isDay: data.current.is_day === 1,
    precipitation: data.current.precipitation,
    cloudCover: data.current.cloud_cover,
    uvIndex: data.current.uv_index,
  };

  const forecast: DailyForecast[] = [];
  const daily = data.daily;
  if (daily && daily.time) {
    for (let i = 0; i < daily.time.length; i++) {
      forecast.push({
        date: daily.time[i],
        temperatureMax: daily.temperature_2m_max[i],
        temperatureMin: daily.temperature_2m_min[i],
        weatherCode: daily.weather_code[i],
        weatherDescription: describeWeatherCode(daily.weather_code[i]),
        precipitationProbability: daily.precipitation_probability_max[i] ?? 0,
        windSpeedMax: daily.wind_speed_10m_max[i],
        uvIndexMax: daily.uv_index_max[i],
        sunrise: daily.sunrise[i],
        sunset: daily.sunset[i],
      });
    }
  }

  return {
    current,
    forecast,
    timezone: geo.timezone,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Format for Nicole's prompt context
// ---------------------------------------------------------------------------

export function formatWeatherForPrompt(result: WeatherResult): string {
  const { current, forecast } = result;

  const lines = [
    `**Weather in ${current.location}**`,
    `Now: ${current.temperature}°C (feels like ${current.feelsLike}°C), ${current.weatherDescription}`,
    `Humidity: ${current.humidity}%, Wind: ${current.windSpeed} km/h, UV: ${current.uvIndex}`,
  ];

  if (current.precipitation > 0) {
    lines.push(`Precipitation: ${current.precipitation} mm`);
  }

  if (forecast.length > 0) {
    lines.push("");
    for (const day of forecast) {
      lines.push(
        `${day.date}: ${day.temperatureMin}–${day.temperatureMax}°C, ${day.weatherDescription}, ${day.precipitationProbability}% rain`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Heartbeat check — used by the heartbeat system for weather alerts
// ---------------------------------------------------------------------------

export async function checkWeatherForHeartbeat(
  location?: string
): Promise<{ shouldAlert: boolean; summary: string } | null> {
  try {
    const weather = await getWeather(location || undefined, 1);
    const { current } = weather;

    // Alert conditions: extreme heat, extreme cold, heavy rain, thunderstorms
    const alerts: string[] = [];

    if (current.temperature >= 35) {
      alerts.push(`extreme heat (${current.temperature}°C)`);
    } else if (current.temperature <= 0) {
      alerts.push(`freezing temperatures (${current.temperature}°C)`);
    }

    if (current.weatherCode >= 95) {
      alerts.push(current.weatherDescription.toLowerCase());
    } else if (current.weatherCode >= 65) {
      alerts.push(current.weatherDescription.toLowerCase());
    }

    if (current.uvIndex >= 8) {
      alerts.push(`very high UV index (${current.uvIndex})`);
    }

    if (current.windSpeed >= 50) {
      alerts.push(`strong winds (${current.windSpeed} km/h)`);
    }

    if (alerts.length === 0) return null;

    return {
      shouldAlert: true,
      summary: `Weather alert for ${current.location}: ${alerts.join(", ")}. Currently ${current.temperature}°C, ${current.weatherDescription}.`,
    };
  } catch {
    return null;
  }
}
