import webpush from "web-push";

const LABELS = {
  fajr: "الفجر",
  dhuhr: "الظهر",
  asr: "العصر",
  maghrib: "المغرب",
  isha: "العشاء",
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/vapid-public-key") {
    return new Response(env.VAPID_PUBLIC_KEY, {
      headers: {
        ...corsHeaders(),
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/subscribe") {
    const body = await safeJson(request);

    if (!body?.subscription?.endpoint) {
      return json({ error: "Invalid subscription payload" }, 400);
    }

    const key = await subscriptionKey(body.subscription.endpoint);

    const record = {
      subscription: body.subscription,
      lat: body.lat ?? null,
      lon: body.lon ?? null,
      timezone: body.timezone ?? null,
      name: body.name ?? null,
      settings: body.settings ?? {},
      userAgent: body.userAgent ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSent: null,
    };

    await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));

    return json({
      ok: true,
      key,
      message: "Subscription saved",
    });
  }

  if (request.method === "POST" && url.pathname === "/unsubscribe") {
    const body = await safeJson(request);
    const endpoint = body?.endpoint;

    if (!endpoint) {
      return json({ error: "Missing endpoint" }, 400);
    }

    const key = await subscriptionKey(endpoint);
    await env.SUBSCRIPTIONS.delete(key);

    return json({
      ok: true,
      key,
      message: "Subscription deleted",
    });
  }

  if (request.method === "GET" && url.pathname === "/subscriptions-count") {
    const list = await env.SUBSCRIPTIONS.list({ limit: 1000 });
    return json({
      ok: true,
      count: list.keys.length,
      complete: list.list_complete,
    });
  }

  if (request.method === "POST" && url.pathname === "/test-push") {
    const body = await safeJson(request);
    const endpoint = body?.endpoint;

    if (!endpoint) {
      return json({ error: "Missing endpoint" }, 400);
    }

    const key = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(key);

    if (!raw) {
      return json({ error: "Subscription not found" }, 404);
    }

    const record = JSON.parse(raw);

    await sendPush(env, record.subscription, {
      title: "اختبار Web Push",
      options: {
        body: "إذا وصل هذا الإشعار والتطبيق مغلق فكل شيء ممتاز.",
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        tag: "test-push",
        renotify: false,
      },
    });

    return json({
      ok: true,
      message: "Test push sent",
    });
  }

  return json({ error: "Not found" }, 404);
}

async function runScheduled(env) {
  const list = await env.SUBSCRIPTIONS.list({ limit: 1000 });

  for (const item of list.keys) {
    const raw = await env.SUBSCRIPTIONS.get(item.name);
    if (!raw) continue;

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!isValidRecord(record)) continue;

    const now = new Date();
    const prayerData = calculatePrayerTimesForRecord(now, record);
    const duePrayer = getDuePrayer(prayerData, now, record.timezone, record.lastSent);

    if (!duePrayer) continue;

    try {
      await sendPush(env, record.subscription, {
        title: `حان وقت ${LABELS[duePrayer.key]}`,
        options: {
          body: `${LABELS[duePrayer.key]} — ${duePrayer.timeText}`,
          icon: "./icons/icon-192.png",
          badge: "./icons/icon-192.png",
          tag: `prayer-${duePrayer.key}-${duePrayer.dateKey}`,
          renotify: false,
        },
      });

      record.lastSent = {
        prayer: duePrayer.key,
        date: duePrayer.dateKey,
        sentAt: new Date().toISOString(),
      };

      await env.SUBSCRIPTIONS.put(item.name, JSON.stringify(record));
    } catch (error) {
      const msg = String(error?.message || error);
      if (msg.includes("410") || msg.includes("404")) {
        await env.SUBSCRIPTIONS.delete(item.name);
      }
    }
  }
}

async function sendPush(env, subscription, payload) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

function calculatePrayerTimesForRecord(now, record) {
  const local = getZonedDateParts(now, record.timezone);

  const tzOffsetMinutes =
    getTimeZoneOffsetMinutes(record.timezone, now) +
    (record.settings?.timezoneMinutes || 0);

  const fajrAngle = Number.isFinite(record.settings?.fajrAngle)
    ? record.settings.fajrAngle
    : 18.5;

  const globalMinutes = record.settings?.globalMinutes || 0;

  const baseDate = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));

  const base = computePrayerHours({
    date: baseDate,
    latitude: record.lat,
    longitude: record.lon,
    tzOffsetMinutes,
    fajrAngle,
  });

  const adjusted = {
    fajr: addMinutes(base.fajr, globalMinutes + (record.settings?.fajr || 0)),
    sunrise: addMinutes(base.sunrise, globalMinutes + (record.settings?.sunrise || 0)),
    dhuhr: addMinutes(base.dhuhr, globalMinutes + (record.settings?.dhuhr || 0)),
    asr: addMinutes(base.asr, globalMinutes + (record.settings?.asr || 0)),
    maghrib: addMinutes(base.maghrib, globalMinutes + (record.settings?.maghrib || 0)),
    isha: addMinutes(base.isha, globalMinutes + (record.settings?.isha || 0)),
  };

  return {
    formatted: Object.fromEntries(
      Object.entries(adjusted).map(([k, v]) => [k, formatTime(v)])
    ),
    minutes: Object.fromEntries(
      Object.entries(adjusted).map(([k, v]) => [k, toMinutes(v)])
    ),
    dateKey: `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`,
  };
}

function getDuePrayer(prayerData, now, timeZone, lastSent) {
  const current = getCurrentMinuteInZone(now, timeZone);

  for (const prayer of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
    const target = prayerData.minutes[prayer];
    if (!Number.isFinite(target)) continue;

    if (current === target) {
      if (lastSent?.date === prayerData.dateKey && lastSent?.prayer === prayer) {
        return null;
      }

      return {
        key: prayer,
        dateKey: prayerData.dateKey,
        timeText: prayerData.formatted[prayer],
      };
    }
  }

  return null;
}

function getCurrentMinuteInZone(now, timeZone) {
  const parts = getZonedDateTimeParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

function computePrayerHours({ date, latitude, longitude, tzOffsetMinutes, fajrAngle }) {
  const DEG = Math.PI / 180;
  const tzHours = tzOffsetMinutes / 60;

  const jd = date.getTime() / 86400000 + 2440587.5 - longitude / 360;
  const d = jd - 2451545;

  const g = fixAngle(357.529 + 0.98560028 * d);
  const q = fixAngle(280.459 + 0.98564736 * d);
  const L = fixAngle(q + 1.915 * Math.sin(g * DEG) + 0.020 * Math.sin(2 * g * DEG));
  const e = 23.439 - 0.00000036 * d;
  const dec = Math.asin(Math.sin(e * DEG) * Math.sin(L * DEG)) / DEG;
  const ra = Math.atan2(Math.cos(e * DEG) * Math.sin(L * DEG), Math.cos(L * DEG)) / DEG / 15;
  const eqTime = q / 15 - fixHour(ra);

  const noon = 12 + tzHours - longitude / 15 - eqTime;

  let fajr = sunAngleTime(fajrAngle, "ccw", latitude, dec, noon);
  const sunrise = sunAngleTime(0.833, "ccw", latitude, dec, noon);
  const dhuhr = noon + 1 / 60;
  const asr = asrTime(1, latitude, dec, noon);
  const sunset = sunAngleTime(0.833, "cw", latitude, dec, noon);
  const maghrib = sunset + 1 / 60;
  const isha = maghrib + 1.5;

  const night = positiveDiffHours(sunrise, sunset);
  if (fajr == null || Number.isNaN(fajr)) {
    fajr = sunrise - night * (fajrAngle / 60);
  }

  return { fajr, sunrise, dhuhr, asr, maghrib, isha };
}

function sunAngleTime(angle, dir, lat, dec, noon) {
  const DEG = Math.PI / 180;
  const latRad = lat * DEG;
  const decRad = dec * DEG;
  const angRad = angle * DEG;

  const cosH =
    (-Math.sin(angRad) - Math.sin(latRad) * Math.sin(decRad)) /
    (Math.cos(latRad) * Math.cos(decRad));

  if (cosH < -1 || cosH > 1) return null;

  const H = Math.acos(cosH) / DEG / 15;
  return dir === "ccw" ? noon - H : noon + H;
}

function asrTime(factor, lat, dec, noon) {
  const DEG = Math.PI / 180;
  const angle = -Math.atan(1 / (factor + Math.tan(Math.abs((lat - dec) * DEG)))) / DEG;
  return sunAngleTime(angle, "cw", lat, dec, noon);
}

function addMinutes(hourValue, minutes) {
  if (hourValue == null) return null;
  return hourValue + minutes / 60;
}

function positiveDiffHours(later, earlier) {
  if (later == null || earlier == null) return 0;
  let diff = later - earlier;
  if (diff < 0) diff += 24;
  return diff;
}

function toMinutes(hourValue) {
  if (hourValue == null) return null;
  const normalized = ((hourValue % 24) + 24) % 24;
  return Math.round(normalized * 60) % 1440;
}

function formatTime(hourValue) {
  if (hourValue == null) return "--:--";
  const total = toMinutes(hourValue);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

function getZonedDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function isValidRecord(record) {
  return (
    record &&
    record.subscription &&
    record.subscription.endpoint &&
    Number.isFinite(record.lat) &&
    Number.isFinite(record.lon) &&
    typeof record.timezone === "string"
  );
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function subscriptionKey(endpoint) {
  const bytes = new TextEncoder().encode(endpoint);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = [...new Uint8Array(hashBuffer)];
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sub:${hashHex}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

function fixAngle(a) {
  return (a % 360 + 360) % 360;
}

function fixHour(h) {
  return (h % 24 + 24) % 24;

}
