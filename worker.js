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
  language: body.language ?? null,
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

    if (request.method === "GET" && url.pathname === "/admin/summary") {
    const subs = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });
    const jobs = await env.SUBSCRIPTIONS.list({ prefix: "job:", limit: 1000 });

    return json({
      ok: true,
      subscriptions: subs.keys.length,
      subscriptions_complete: subs.list_complete,
      jobs: jobs.keys.length,
      jobs_complete: jobs.list_complete,
      now_utc: new Date().toISOString(),
    });
  }

  if (request.method === "POST" && url.pathname === "/admin/manual-push") {
    const body = await safeJson(request);

    const mode = body?.mode || "now";
    const target = body?.target || "all";
    const endpoints = Array.isArray(body?.endpoints) ? body.endpoints : [];
    const language = body?.language || "ar";
    const timezone = body?.timezone || "UTC";
    const title = body?.title || (language === "ar" ? "إشعار يدوي" : "Manual Push");
    const bodyText = body?.body || "";
    const scheduleAtLocal = body?.scheduleAtLocal || null;
    const extraOptions = body?.extraOptions || {};

    const payload = {
      title,
      options: {
        body: bodyText,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        tag: `manual-${Date.now()}`,
        renotify: false,
        ...extraOptions,
      },
    };

    if (mode === "now") {
      const sent = await sendManualPushNow(env, { target, endpoints, payload });
      return json({
        ok: true,
        mode,
        target,
        sent,
      });
    }

    if (!scheduleAtLocal) {
      return json({ error: "scheduleAtLocal is required for scheduled mode" }, 400);
    }

    const dueAt = zonedLocalToUtcIso(scheduleAtLocal, timezone);

    const job = {
      type: "manual-push",
      status: "pending",
      target,
      endpoints,
      language,
      timezone,
      dueAt,
      payload,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };

    const jobId = `job:${crypto.randomUUID()}`;
    await env.SUBSCRIPTIONS.put(jobId, JSON.stringify(job));

    return json({
      ok: true,
      mode,
      jobId,
      dueAt,
    });
  }

  if (request.method === "POST" && url.pathname === "/admin/patch-subscriber") {
    const body = await safeJson(request);
    const endpoint = body?.endpoint;
    const patch = body?.patch || {};

    if (!endpoint) {
      return json({ error: "Missing endpoint" }, 400);
    }

    const key = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(key);

    if (!raw) {
      return json({ error: "Subscription not found" }, 404);
    }

    const record = JSON.parse(raw);

    if (patch.name !== undefined && patch.name !== null) record.name = patch.name;
    if (patch.language !== undefined && patch.language !== null) record.language = patch.language;
    if (patch.timezone !== undefined && patch.timezone !== null) record.timezone = patch.timezone;
    if (patch.lat !== undefined && patch.lat !== null) record.lat = patch.lat;
    if (patch.lon !== undefined && patch.lon !== null) record.lon = patch.lon;
    if (patch.settings !== undefined && patch.settings !== null) record.settings = patch.settings;
    if (patch.customAttributes !== undefined && patch.customAttributes !== null) {
      record.customAttributes = patch.customAttributes;
    }

    record.updatedAt = new Date().toISOString();

    await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));

    return json({
      ok: true,
      key,
      message: "Subscriber patched",
      record,
    });
  }
  }

if (request.method === "GET" && url.pathname === "/admin/subscribers") {
  const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });
  const subscribers = [];

  for (const item of list.keys) {
    const raw = await env.SUBSCRIPTIONS.get(item.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);
      subscribers.push({
        endpoint: record.subscription?.endpoint || null,
        name: record.name || null,
        language: record.language || null,
        timezone: record.timezone || null,
        userAgent: record.userAgent || null,
        createdAt: record.createdAt || null,
        lastSent: record.lastSent || null,
        customAttributes: record.customAttributes || null,
      });
    } catch {
      // ignore bad record
    }
  }

  return json({
    ok: true,
    subscribers,
  });
}
  
  return json({ error: "Not found" }, 404);
}

async function runScheduled(env) {
  await processManualJobs(env);

  const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });

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

async function sendManualPushNow(env, { target, endpoints, payload }) {
  let sent = 0;

  if (target === "selected") {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error("Missing endpoints for selected target");
    }

    for (const endpoint of endpoints) {
      const key = await subscriptionKey(endpoint);
      const raw = await env.SUBSCRIPTIONS.get(key);
      if (!raw) continue;

      try {
        const record = JSON.parse(raw);
        await sendPush(env, record.subscription, payload);

        record.lastSent = {
          prayer: "manual",
          date: localDateKey(new Date()),
          sentAt: new Date().toISOString(),
        };
        await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
        sent += 1;
      } catch (error) {
        const msg = String(error?.message || error);
        if (msg.includes("410") || msg.includes("404")) {
          await env.SUBSCRIPTIONS.delete(key);
        }
      }
    }

    console.log("Manual push sent", {
      target: "selected",
      sent,
      sentAt: new Date().toISOString(),
    });

    return sent;
  }

  const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });

  for (const item of list.keys) {
    const raw = await env.SUBSCRIPTIONS.get(item.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);
      if (!record?.subscription?.endpoint) continue;

      await sendPush(env, record.subscription, payload);

      record.lastSent = {
        prayer: "manual",
        date: localDateKey(new Date()),
        sentAt: new Date().toISOString(),
      };
      await env.SUBSCRIPTIONS.put(item.name, JSON.stringify(record));

      sent += 1;
    } catch (error) {
      const msg = String(error?.message || error);
      if (msg.includes("410") || msg.includes("404")) {
        await env.SUBSCRIPTIONS.delete(item.name);
      }
    }
  }

  console.log("Manual push sent", {
    target: "all",
    sent,
    sentAt: new Date().toISOString(),
  });

  return sent;
}

async function processManualJobs(env) {
  const jobs = await env.SUBSCRIPTIONS.list({ prefix: "job:", limit: 1000 });
  const now = new Date();

  for (const item of jobs.keys) {
    const raw = await env.SUBSCRIPTIONS.get(item.name);
    if (!raw) continue;

    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      continue;
    }

    if (job?.status !== "pending") continue;
    if (!job?.dueAt) continue;

    const due = new Date(job.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    if (due.getTime() > now.getTime()) continue;

    try {
      const sent = await sendManualPushNow(env, {
        target: job.target || "all",
        endpoints: Array.isArray(job.endpoints) ? job.endpoints : [],
        payload: job.payload,
      });

      job.status = "sent";
      job.sentAt = new Date().toISOString();
      job.sentCount = sent;

      await env.SUBSCRIPTIONS.put(item.name, JSON.stringify(job));

      console.log("Scheduled manual push sent", {
        jobId: item.name,
        sent,
        dueAt: job.dueAt,
        sentAt: job.sentAt,
      });
    } catch (error) {
      job.status = "failed";
      job.error = String(error?.message || error);
      job.sentAt = new Date().toISOString();

      await env.SUBSCRIPTIONS.put(item.name, JSON.stringify(job));

      console.log("Scheduled manual push failed", {
        jobId: item.name,
        error: job.error,
        sentAt: job.sentAt,
      });
    }
  }
}

function zonedLocalToUtcIso(localDateTimeString, timeZone) {
  const [datePart, timePart] = localDateTimeString.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, guess);
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, 0) - (offsetMinutes * 60000);

  return new Date(utcMillis).toISOString();

}

