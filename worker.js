import webpush from "web-push";

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

    const subKey = await subscriptionKey(body.subscription.endpoint);

    const existingRaw = await env.SUBSCRIPTIONS.get(subKey);
    let existing = null;

    try {
      existing = existingRaw ? JSON.parse(existingRaw) : null;
    } catch {
      existing = null;
    }

    if (existing) {
      await removeScheduledBucketsForRecord(env, subKey, existing, 7);
    }

    const record = {
      subscription: body.subscription,
      lat: body.lat ?? null,
      lon: body.lon ?? null,
      timezone: body.timezone ?? null,
      language: body.language ?? "ar",
      name: body.name ?? null,
      userAgent: body.userAgent ?? null,
      settings: sanitizeSettings(body.settings),
      customAttributes: body.customAttributes ?? existing?.customAttributes ?? {},
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSent: existing?.lastSent ?? null,
      scheduleVersion: Date.now(),
    };

    await env.SUBSCRIPTIONS.put(subKey, JSON.stringify(record));
    await buildInitialBuckets(env, subKey, record, 7);

    return json({
      ok: true,
      key: subKey,
      message: "Subscription saved",
    });
  }

  if (request.method === "POST" && url.pathname === "/unsubscribe") {
    const body = await safeJson(request);
    const endpoint = body?.endpoint;

    if (!endpoint) {
      return json({ error: "Missing endpoint" }, 400);
    }

    const subKey = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(subKey);

    if (raw) {
      try {
        const record = JSON.parse(raw);
        await removeScheduledBucketsForRecord(env, subKey, record, 7);
      } catch {
        // ignore
      }
    }

    await env.SUBSCRIPTIONS.delete(subKey);

    return json({
      ok: true,
      key: subKey,
      message: "Subscription deleted",
    });
  }

  if (request.method === "GET" && url.pathname === "/subscriptions-count") {
    const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });
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

    const subKey = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(subKey);

    if (!raw) {
      return json({ error: "Subscription not found" }, 404);
    }

    const record = JSON.parse(raw);

    await sendPush(env, record.subscription, {
      title: "اختبار Web Push",
      options: {
        body: "إذا وصل هذا الإشعار والتطبيق مغلق فكل شيء ممتاز.",
        tag: "test-push",
        renotify: false,
      },
    });

    return json({
      ok: true,
      message: "Test push sent",
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/summary") {
    const subs = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });
    const jobs = await env.SUBSCRIPTIONS.list({ prefix: "bucket:", limit: 1000 });

    return json({
      ok: true,
      subscriptions: subs.keys.length,
      subscriptions_complete: subs.list_complete,
      buckets: jobs.keys.length,
      buckets_complete: jobs.list_complete,
      now_utc: new Date().toISOString(),
    });
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
        tag: extraOptions?.tag || `manual-${Date.now()}`,
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
    const bucketKey = bucketKeyFromIso(dueAt);

    let records = [];

    if (target === "all") {
      const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:", limit: 1000 });

      for (const item of list.keys) {
        const raw = await env.SUBSCRIPTIONS.get(item.name);
        if (!raw) continue;

        try {
          const record = JSON.parse(raw);
          if (record?.subscription?.endpoint) {
            records.push({ subKey: item.name, record });
          }
        } catch {
          // ignore
        }
      }
    } else {
      records = await resolveRecordsByEndpoints(env, endpoints);
    }

    const entries = records.map(({ subKey, record }) => ({
      id: `manual:${crypto.randomUUID()}`,
      type: "manual-push",
      dueAt,
      subKey,
      subscription: record.subscription,
      title: payload.title,
      body: payload.options.body,
      tag: payload.options.tag,
      renotify: payload.options.renotify ?? false,
    }));

    await upsertBucketEntries(env, bucketKey, entries);

    return json({
      ok: true,
      mode,
      target,
      bucketKey,
      dueAt,
      count: entries.length,
    });
  }

  if (request.method === "POST" && url.pathname === "/admin/patch-subscriber") {
    const body = await safeJson(request);
    const endpoint = body?.endpoint;
    const patch = body?.patch || {};

    if (!endpoint) {
      return json({ error: "Missing endpoint" }, 400);
    }

    const subKey = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(subKey);

    if (!raw) {
      return json({ error: "Subscription not found" }, 404);
    }

    const record = JSON.parse(raw);
    const previous = JSON.parse(raw);

    if (patch.name !== undefined && patch.name !== null) record.name = patch.name;
    if (patch.language !== undefined && patch.language !== null) record.language = patch.language;
    if (patch.timezone !== undefined && patch.timezone !== null) record.timezone = patch.timezone;
    if (patch.lat !== undefined && patch.lat !== null) record.lat = patch.lat;
    if (patch.lon !== undefined && patch.lon !== null) record.lon = patch.lon;
    if (patch.settings !== undefined && patch.settings !== null) record.settings = sanitizeSettings(patch.settings);
    if (patch.customAttributes !== undefined && patch.customAttributes !== null) {
      record.customAttributes = patch.customAttributes;
    }

    const scheduleAffects =
      patch.language !== undefined ||
      patch.timezone !== undefined ||
      patch.lat !== undefined ||
      patch.lon !== undefined ||
      patch.settings !== undefined;

    if (scheduleAffects) {
      await removeScheduledBucketsForRecord(env, subKey, previous, 7);
      record.scheduleVersion = Date.now();
    }

    record.updatedAt = new Date().toISOString();

    await env.SUBSCRIPTIONS.put(subKey, JSON.stringify(record));

    if (scheduleAffects) {
      await buildInitialBuckets(env, subKey, record, 7);
    }

    return json({
      ok: true,
      key: subKey,
      message: "Subscriber patched",
      record,
    });
  }

  return json({ error: "Not found" }, 404);
}

async function runScheduled(env) {
  const now = new Date();
  const bucketKey = bucketKeyFromDate(now);

  const raw = await env.SUBSCRIPTIONS.get(bucketKey);
  if (!raw) return;

  let entries = [];

  try {
    entries = JSON.parse(raw);
    if (!Array.isArray(entries)) entries = [];
  } catch {
    await env.SUBSCRIPTIONS.delete(bucketKey);
    return;
  }

  for (const entry of entries) {
    try {
      await sendPush(env, entry.subscription, {
        title: entry.title,
        options: {
          body: entry.body,
          tag: entry.tag,
          renotify: entry.renotify ?? false,
        },
      });

      if (entry.subKey) {
        const rawSub = await env.SUBSCRIPTIONS.get(entry.subKey);
        if (rawSub) {
          try {
            const record = JSON.parse(rawSub);
            record.lastSent = {
              prayer: entry.prayer || "manual",
              date: entry.dateKey || localDateKey(new Date()),
              sentAt: new Date().toISOString(),
            };
            await env.SUBSCRIPTIONS.put(entry.subKey, JSON.stringify(record));
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      const msg = String(err?.message || err);

      if ((msg.includes("410") || msg.includes("404")) && entry.subKey) {
        await env.SUBSCRIPTIONS.delete(entry.subKey);
      }

      console.log("Bucket send failed", {
        bucketKey,
        entryId: entry?.id || null,
        error: msg,
      });
    }
  }

  await env.SUBSCRIPTIONS.delete(bucketKey);
}

async function sendPush(env, subscription, payload) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

async function sendManualPushNow(env, { target, endpoints, payload }) {
  let sent = 0;

  if (target === "selected") {
    const records = await resolveRecordsByEndpoints(env, endpoints);

    for (const { subKey, record } of records) {
      try {
        await sendPush(env, record.subscription, payload);

        record.lastSent = {
          prayer: "manual",
          date: localDateKey(new Date()),
          sentAt: new Date().toISOString(),
        };

        await env.SUBSCRIPTIONS.put(subKey, JSON.stringify(record));
        sent += 1;
      } catch (error) {
        const msg = String(error?.message || error);
        if (msg.includes("410") || msg.includes("404")) {
          await env.SUBSCRIPTIONS.delete(subKey);
        }
      }
    }

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

  return sent;
}

async function resolveRecordsByEndpoints(env, endpoints) {
  const records = [];

  for (const endpoint of endpoints || []) {
    const subKey = await subscriptionKey(endpoint);
    const raw = await env.SUBSCRIPTIONS.get(subKey);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);
      if (record?.subscription?.endpoint) {
        records.push({ subKey, record });
      }
    } catch {
      // ignore
    }
  }

  return records;
}

function sanitizeSettings(settings) {
  const s = settings || {};
  return {
    timezoneMinutes: Number.isFinite(s.timezoneMinutes) ? s.timezoneMinutes : 0,
    fajr: Number.isFinite(s.fajr) ? s.fajr : 0,
    sunrise: Number.isFinite(s.sunrise) ? s.sunrise : 0,
    dhuhr: Number.isFinite(s.dhuhr) ? s.dhuhr : 0,
    asr: Number.isFinite(s.asr) ? s.asr : 0,
    maghrib: Number.isFinite(s.maghrib) ? s.maghrib : 0,
    isha: Number.isFinite(s.isha) ? s.isha : 0,
  };
}

async function buildInitialBuckets(env, subKey, record, daysAhead = 7) {
  const entries = createPrayerBucketEntriesForRecord(subKey, record, daysAhead);

  for (const { bucketKey, entry } of entries) {
    await upsertBucketEntries(env, bucketKey, [entry]);
  }
}

async function removeScheduledBucketsForRecord(env, subKey, record, daysAhead = 7) {
  const entries = createPrayerBucketEntriesForRecord(subKey, record, daysAhead);

  for (const { bucketKey, entry } of entries) {
    const raw = await env.SUBSCRIPTIONS.get(bucketKey);
    if (!raw) continue;

    let arr = [];
    try {
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }

    const filtered = arr.filter((item) => item.id !== entry.id);

    if (filtered.length === 0) {
      await env.SUBSCRIPTIONS.delete(bucketKey);
    } else if (filtered.length !== arr.length) {
      await env.SUBSCRIPTIONS.put(bucketKey, JSON.stringify(filtered));
    }
  }
}

function createPrayerBucketEntriesForRecord(subKey, record, daysAhead = 7) {
  const result = [];

  for (let i = 0; i < daysAhead; i++) {
    const dateParts = getZonedDatePartsPlus(record.timezone, i);
    const prayerEntries = calculatePrayersForDateParts(dateParts, record);

    for (const p of prayerEntries) {
      result.push({
        bucketKey: bucketKeyFromIso(p.dueAt),
        entry: {
          id: `prayer:${subKey}:${p.dateKey}:${p.prayer}:v${record.scheduleVersion}`,
          type: "prayer-push",
          subKey,
          prayer: p.prayer,
          dateKey: p.dateKey,
          dueAt: p.dueAt,
          subscription: record.subscription,
          title: p.title,
          body: p.body,
          tag: p.tag,
          renotify: false,
          scheduleVersion: record.scheduleVersion,
        },
      });
    }
  }

  return result;
}

function calculatePrayersForDateParts(dateParts, record) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 12, 0, 0));

  const tzOffsetMinutes =
    getTimeZoneOffsetMinutes(record.timezone, date) +
    (record.settings?.timezoneMinutes || 0);

  const base = computePrayerHours({
    date,
    latitude: record.lat,
    longitude: record.lon,
    tzOffsetMinutes,
  });

  const adjusted = {
    fajr: addMinutes(base.fajr, record.settings?.fajr || 0),
    sunrise: addMinutes(base.sunrise, record.settings?.sunrise || 0),
    dhuhr: addMinutes(base.dhuhr, record.settings?.dhuhr || 0),
    asr: addMinutes(base.asr, record.settings?.asr || 0),
    maghrib: addMinutes(base.maghrib, record.settings?.maghrib || 0),
    isha: addMinutes(base.isha, record.settings?.isha || 0),
  };

  const dateKey = `${dateParts.year}-${pad2(dateParts.month)}-${pad2(dateParts.day)}`;
  const lang = record.language === "en" ? "en" : "ar";

  return ["fajr", "dhuhr", "asr", "maghrib", "isha"].map((prayer) => {
    const totalMinutes = toMinutes(adjusted[prayer]);
    const hh = pad2(Math.floor(totalMinutes / 60));
    const mm = pad2(totalMinutes % 60);

    const localDateTimeString =
      `${dateParts.year}-${pad2(dateParts.month)}-${pad2(dateParts.day)}T${hh}:${mm}`;

    const dueAt = zonedLocalToUtcIso(localDateTimeString, record.timezone);
    const label = getPrayerLabel(prayer, lang);
    const formatted = formatTime(adjusted[prayer]);

    return {
      prayer,
      dateKey,
      dueAt,
      title: lang === "ar" ? `حان وقت ${label}` : `It's time for ${label}`,
      body: `${label} — ${formatted}`,
      tag: `prayer-${prayer}-${dateKey}`,
    };
  });
}

async function upsertBucketEntries(env, bucketKey, newEntries) {
  const raw = await env.SUBSCRIPTIONS.get(bucketKey);

  let arr = [];
  if (raw) {
    try {
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
  }

  const map = new Map(arr.map((item) => [item.id, item]));
  for (const entry of newEntries) {
    map.set(entry.id, entry);
  }

  await env.SUBSCRIPTIONS.put(bucketKey, JSON.stringify([...map.values()]));
}

function computePrayerHours({ date, latitude, longitude, tzOffsetMinutes }) {
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

  let fajr = sunAngleTime(18.5, "ccw", latitude, dec, noon);
  const sunrise = sunAngleTime(0.833, "ccw", latitude, dec, noon);
  const dhuhr = noon + 1 / 60;
  const asr = asrTime(1, latitude, dec, noon);
  const sunset = sunAngleTime(0.833, "cw", latitude, dec, noon);
  const maghrib = sunset + 1 / 60;
  const isha = maghrib + 1.5;

  const night = positiveDiffHours(sunrise, sunset);

  if (fajr == null || Number.isNaN(fajr)) {
    fajr = sunrise - night * (18.5 / 60);
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
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
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

function getZonedDatePartsPlus(timeZone, dayOffset = 0) {
  const base = getZonedDateParts(new Date(), timeZone);
  const d = new Date(Date.UTC(base.year, base.month - 1, base.day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + dayOffset);

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
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

function zonedLocalToUtcIso(localDateTimeString, timeZone) {
  const [datePart, timePart] = localDateTimeString.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, guess);
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, 0) - (offsetMinutes * 60000);

  return new Date(utcMillis).toISOString();
}

function getPrayerLabel(prayer, language) {
  const labels = {
    ar: {
      fajr: "الفجر",
      dhuhr: "الظهر",
      asr: "العصر",
      maghrib: "المغرب",
      isha: "العشاء",
    },
    en: {
      fajr: "Fajr",
      dhuhr: "Dhuhr",
      asr: "Asr",
      maghrib: "Maghrib",
      isha: "Isha",
    },
  };

  return (labels[language] || labels.en)[prayer] || prayer;
}

function bucketKeyFromDate(date) {
  return `bucket:${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}Z`;
}

function bucketKeyFromIso(isoString) {
  return bucketKeyFromDate(new Date(isoString));
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function pad2(value) {
  return String(value).padStart(2, "0");
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
