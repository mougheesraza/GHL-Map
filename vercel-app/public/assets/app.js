let map;
let markers = [];
let peakCircle = null;
let isLoading = false;
let displayedLocation = null;
let currentSnapshot = null;
let snapshotTimer = null;
let autoSyncTimer = null;
let mapWasFocused = false;

function saveSnapshot() {
    if (!currentSnapshot) return;
    try {
        localStorage.setItem(`ghl-map.snapshot.v1:${currentSnapshot.locationId}`, JSON.stringify(currentSnapshot));
    } catch (_) {
        document.getElementById("statusText").textContent = "Browser storage is full or unavailable. This view could not be saved.";
    }
}

function scheduleSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => { snapshotTimer = null; saveSnapshot(); }, 1000);
}

function readSnapshot() {
    try {
        const value = JSON.parse(localStorage.getItem(`ghl-map.snapshot.v1:${locationId}`));
        if (value && value.locationId === locationId && Array.isArray(value.contacts) && Array.isArray(value.locations)) return value;
    } catch (_) {}
    return {locationId, contacts: [], locations: [], cursor: null, complete: false, resolved: [], updatedAt: null};
}

let locationId = new URLSearchParams(window.location.search).get("location_id") || "";
const savedLocationKey = "ghl-contact-map.location-id";
const locationInput = document.getElementById("locationInput");
if (!locationId && !new URLSearchParams(window.location.search).has("location_id")) {
    try { locationId = localStorage.getItem(savedLocationKey) || ""; } catch (_) {}
}
if (!/^[a-zA-Z0-9_-]+$/.test(locationId)) locationId = "";
locationInput.value = locationId;
document.getElementById("locationId").textContent = locationId || "None selected";


// ============================================
// Initialize Map
// ============================================

function initializeMap() {

    map = L.map("map").setView(
        [31.5204, 74.3587],
        10
    );

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap contributors"
        }
    ).addTo(map);
}


// ============================================
// Clear Markers
// ============================================

function clearMarkers() {

    markers.forEach(marker => {
        map.removeLayer(marker);
    });

    markers = [];

    if (peakCircle) {
        map.removeLayer(peakCircle);
        peakCircle = null;
    }
}


// ============================================
// Get Address
// ============================================

function getContactAddress(contact) {

    const possibleFields = [

        contact.address,

        contact.fullAddress,

        contact.address1,

        contact.addressLine1

    ];

    for (const value of possibleFields) {

        if (
            typeof value === "string" &&
            value.trim() !== ""
        ) {
            return [...new Set([value, contact.city, contact.state, contact.postalCode, contact.country]
                .filter(part => typeof part === "string" && part.trim())
                .map(part => part.trim()))].join(", ");
        }
    }

    return [contact.city, contact.state, contact.postalCode, contact.country]
        .filter(part => typeof part === "string" && part.trim()).join(", ");
}


// ============================================
// Geocode Address
// ============================================

const geocodeCache = new Map();
let lastGeocodeAt = 0;

function coordinates(lat, lng) {
    if (lat === null || lng === null || lat === undefined || lng === undefined ||
        String(lat).trim() === "" || String(lng).trim() === "") return null;
    lat = Number(lat); lng = Number(lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? {lat, lng} : null;
}

async function fetchJson(url, timeout = 35000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {signal: controller.signal, headers: {Accept: "application/json"}});
        if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}). Please refresh to retry.`);
        return await response.json();
    } finally { clearTimeout(timer); }
}

async function geocodeAddress(address) {
    const key = `${locationId}:${address.trim().toLowerCase()}`;
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    const storageKey = `ghl-geocode.v1:${key}`;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && Date.now() - saved.time < 30 * 86400000 && coordinates(saved.lat, saved.lng)) {
            geocodeCache.set(key, saved);
            return saved;
        }
    } catch (_) {}
    // Public geocoder: one request per second, including failed lookups.
    await sleep(Math.max(0, 1100 - (Date.now() - lastGeocodeAt)));
    lastGeocodeAt = Date.now();
    const data = await fetchJson("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({q: address, format: "json", limit: 1}), 12000);
    if (!Array.isArray(data)) throw new Error("Invalid geocoder response.");
    const point = data.length ? coordinates(data[0].lat, data[0].lon) : null;
    geocodeCache.set(key, point);
    if (point) {
        try { localStorage.setItem(storageKey, JSON.stringify({...point, time: Date.now()})); } catch (_) {}
    }
    return point;
}

async function loadContacts() {
    if (isLoading) return;
    const loading = document.getElementById("loading");
    const status = document.getElementById("statusText");
    if (!locationId) {
        loading.style.display = "none";
        status.textContent = "Enter a sub-account Location ID to load contacts.";
        return;
    }
    isLoading = true;
    locationInput.disabled = true;
    document.getElementById("saveLocationButton").disabled = true;
    document.getElementById("refreshButton").disabled = true;
    clearTimeout(autoSyncTimer);
    if (displayedLocation !== locationId) {
        saveSnapshot();
        currentSnapshot = readSnapshot();
        displayedLocation = locationId;
        document.getElementById("mapSearch").value = "";
        document.getElementById("mapSearchCount").textContent = "";
        clearMarkers();
        mapWasFocused = false;
        currentSnapshot.locations = currentSnapshot.locations.filter(item => item && item.contact && coordinates(item.lat, item.lng));
        addMarkers(currentSnapshot.locations);
    }
    const contacts = currentSnapshot.contacts, locations = currentSnapshot.locations;
    const seen = new Set(contacts.map(contact => contact.id).filter(Boolean)), cursors = new Set();
    const resolved = new Set(currentSnapshot.resolved || []);
    const mappedIds = new Set(locations.map(item => item.contact.id));
    const queue = contacts.filter(contact => getContactAddress(contact) && !mappedIds.has(contact.id) && !resolved.has(contact.id));
    let done = false, checked = 0, lookupErrors = 0, apiTotal = null, warning = "", loadError = "";
    loading.style.display = "none";
    document.getElementById("lastUpdated").textContent = currentSnapshot.updatedAt ? "Last updated: " + new Date(currentSnapshot.updatedAt).toLocaleString() : "";
    calculateZones(locations);
    renderContactStats(contacts);
    status.textContent = "";
    const progress = () => {
        scheduleSnapshot();
    };
    const addPoint = (contact, point) => {
        const item = {...point, contact};
        locations.push(item);
        addMarkers([item]);
        calculateZones(locations);
        if (document.getElementById("mapSearch").value) filterMapPins();
    };
    // Geocoding runs independently so slow lookups never block the next contact page.
    const worker = async () => {
        while (!done || checked < queue.length) {
            if (checked >= queue.length) { await sleep(50); continue; }
            const contact = queue[checked];
            try {
                const point = await geocodeAddress(getContactAddress(contact));
                if (point) addPoint(contact, point);
                if (contact.id) resolved.add(contact.id);
                currentSnapshot.resolved = [...resolved];
            } catch (_) {
                lookupErrors++;
            }
            checked++;
            progress();
        }
    };
    progress();
    const mapping = worker();
    try {
        let cursor = currentSnapshot.complete ? null : currentSnapshot.cursor;
        currentSnapshot.complete = false;
        for (let page = 0; page < 5000; page++) {
            const params = new URLSearchParams({location_id: locationId});
            if (cursor) params.set("cursor", JSON.stringify(cursor));
            const result = await fetchJson("api/contacts.php?" + params);
            if (!result.success) throw new Error(result.message || "Unable to load contacts.");
            if (!Array.isArray(result.contacts)) throw new Error("Invalid contacts response.");
            if (typeof result.apiTotal === "number") apiTotal = result.apiTotal;
            for (const contact of result.contacts) {
                if (!contact || typeof contact !== "object") continue;
                if (contact.id && seen.has(contact.id)) continue;
                if (contact.id) seen.add(contact.id);
                // Keep only dashboard fields; full CRM records can exceed browser storage.
                const storedContact = {};
                ["id", "firstName", "lastName", "name", "email", "address", "fullAddress", "address1", "addressLine1", "city", "state", "postalCode", "country", "latitude", "longitude", "lat", "lng", "lon"].forEach(field => {
                    if (typeof contact[field] === "string" || typeof contact[field] === "number") storedContact[field] = contact[field];
                });
                contacts.push(storedContact);
                const point = coordinates(contact.latitude ?? contact.lat, contact.longitude ?? contact.lng ?? contact.lon);
                if (point) addPoint(storedContact, point);
                else if (getContactAddress(contact)) {
                    queue.push(storedContact);
                }
            }
            renderContactStats(contacts);
            progress();
            if (result.warning) warning = result.warning;
            if (!result.hasMore) {
                currentSnapshot.complete = !result.warning;
                currentSnapshot.cursor = null;
                saveSnapshot();
                break;
            }
            const key = JSON.stringify(result.nextCursor);
            if (!Array.isArray(result.nextCursor) || !result.contacts.length || cursors.has(key)) {
                throw new Error("Pagination stopped; results may be incomplete.");
            }
            cursors.add(key);
            cursor = result.nextCursor;
            currentSnapshot.cursor = cursor;
            saveSnapshot();
            if (page === 4999) warning = "Page limit reached; results may be incomplete.";
        }
    } catch (error) {
        loadError = error.name === "AbortError" ? "Contact request timed out. Refresh to retry." : error.message;
    } finally {
        done = true;
        await mapping;
        loading.style.display = "none";
        isLoading = false;
        locationInput.disabled = false;
        document.getElementById("saveLocationButton").disabled = false;
        document.getElementById("refreshButton").disabled = false;
        currentSnapshot.updatedAt = Date.now();
        saveSnapshot();
        autoSyncTimer = setTimeout(() => { if (!document.hidden) loadContacts(); }, 60000);
    }
    status.textContent = loadError || warning || (lookupErrors ? "Some address lookups failed. They will be retried during the next update." : "");
    document.getElementById("lastUpdated").textContent = `${loadError || warning ? "Partial update: " : "Last updated: "}${new Date().toLocaleString()}`;
}

function renderContactStats(contacts) {
    const states = new Map();
    let withAddress = 0;
    contacts.forEach(contact => {
        if (getContactAddress(contact)) withAddress++;
        const state = [contact.state || "State not provided", contact.country].filter(Boolean).join(", ");
        states.set(state, (states.get(state) || 0) + 1);
    });
    document.getElementById("totalContacts").textContent = contacts.length;
    document.getElementById("withAddress").textContent = withAddress;
    document.getElementById("withoutAddress").textContent = contacts.length - withAddress;
    document.getElementById("coverage").textContent = (contacts.length ? (100 * withAddress / contacts.length).toFixed(1) : 0) + "%";
    const list = document.getElementById("stateList");
    list.replaceChildren();
    if (!contacts.length) list.textContent = "No contacts received yet.";
    [...states].sort((a, b) => b[1] - a[1]).forEach(([state, count]) => {
        const row = document.createElement("div");
        row.className = "zone-item";
        row.textContent = `${state}: ${count} contacts`;
        list.appendChild(row);
    });
}

function addMarkers(locations) {

    const bounds = markers.map(marker => marker.getLatLng());

    locations.forEach(item => {

        const contact =
            item.contact;

        const name =
            (
                contact.firstName ||
                ""
            ) +
            " " +
            (
                contact.lastName ||
                ""
            );

        const email =
            contact.email ||
            "No email";

        const marker =
            L.marker([
                item.lat,
                item.lng
            ]).addTo(map);

        marker.bindPopup(`
            <strong>
                ${escapeHtml(name.trim() || "Contact")}
            </strong>
            <br>
            ${escapeHtml(email)}
            <br><br>
            ${escapeHtml(
                getContactAddress(contact)
            )}
        `);

        markers.push(marker);
        marker.searchText = [name, email, getContactAddress(contact)].join(" ").toLowerCase();
        const searchTerm = document.getElementById("mapSearch").value.trim().toLowerCase();
        if (searchTerm && !marker.searchText.includes(searchTerm)) map.removeLayer(marker);

        bounds.push([
            item.lat,
            item.lng
        ]);
    });


    if (bounds.length && !mapWasFocused) {

        map.fitBounds(
            bounds,
            {
                padding: [30, 30], maxZoom: 15
            }
        );
        mapWasFocused = true;
    }
}


// ============================================
// Calculate Peak Zones
// ============================================

function calculateZones(locations) {
    if (peakCircle) { map.removeLayer(peakCircle); peakCircle = null; }

    if (!locations.length) {

        document.getElementById("zoneList").textContent = "No mapped contacts.";

        document.getElementById(
            "peakZone"
        ).textContent =
            "No address data";

        document.getElementById(
            "peakCount"
        ).textContent =
            "0 contacts";

        return;
    }


    /*
     * Grid-based geographic clustering.
     *
     * Contacts within approximately
     * 0.02 degrees are grouped together.
     */

    const zoneSize = 0.02;

    const zones = {};


    locations.forEach(item => {

        const latZone =
            Math.floor(
                item.lat / zoneSize
            );

        const lngZone =
            Math.floor(
                item.lng / zoneSize
            );

        const key =
            latZone + "_" + lngZone;

        if (!zones[key]) {

            zones[key] = {
                count: 0,
                lat: 0,
                lng: 0
            };
        }

        zones[key].count++;

        zones[key].lat += item.lat;

        zones[key].lng += item.lng;
    });


    const sortedZones =
        Object.values(zones)
            .map(zone => {

                zone.lat /=
                    zone.count;

                zone.lng /=
                    zone.count;

                return zone;
            })
            .sort(
                (a, b) =>
                    b.count - a.count
            );


    const peak =
        sortedZones[0];


    if (!peak) return;


    // ----------------------------------------
    // Peak Zone UI
    // ----------------------------------------

    document.getElementById(
        "peakZone"
    ).textContent =
        `${peak.lat.toFixed(4)}, ${peak.lng.toFixed(4)}`;

    document.getElementById(
        "peakCount"
    ).textContent =
        `${peak.count} contacts`;


    // ----------------------------------------
    // Highlight Peak Zone
    // ----------------------------------------

    peakCircle =
        L.circle(
            [peak.lat, peak.lng],
            {
                radius: 1800
            }
        ).addTo(map);


    peakCircle.bindPopup(
        `<strong>🔥 Peak Zone</strong><br>
         ${peak.count} contacts`
    );


    // ----------------------------------------
    // Top zones
    // ----------------------------------------

    const zoneList =
        document.getElementById(
            "zoneList"
        );

    zoneList.innerHTML = "";


    sortedZones
        .slice(0, 5)
        .forEach((zone, index) => {

            const div =
                document.createElement(
                    "button"
                );

            div.className =
                "zone-item";
            div.type = "button";
            div.addEventListener("click", () => map.setView([zone.lat, zone.lng], 14));

            div.innerHTML = `
                <div class="zone-name">
                    #${index + 1}
                    ${zone.lat.toFixed(3)},
                    ${zone.lng.toFixed(3)}
                </div>

                <div class="zone-count">
                    ${zone.count} contacts
                </div>
                <div class="zone-bar"><span style="width:${(zone.count / peak.count * 100).toFixed(1)}%"></span></div>
            `;

            zoneList.appendChild(div);
        });
}


// ============================================
// Utility
// ============================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
    );
}


function escapeHtml(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// ============================================
// Events
// ============================================

document
    .getElementById("refreshButton")
    .addEventListener(
        "click",
        loadContacts
    );

document.getElementById("locationForm").addEventListener("submit", event => {
    event.preventDefault();
    if (isLoading) return;
    const value = locationInput.value.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        document.getElementById("statusText").textContent = "Enter a valid Location ID.";
        return;
    }
    locationId = value;
    locationInput.value = value;
    document.getElementById("locationId").textContent = value;
    try { localStorage.setItem(savedLocationKey, value); } catch (_) {}
    const url = new URL(window.location.href);
    url.searchParams.set("location_id", value);
    window.history.replaceState(null, "", url);
    loadContacts();
});


// ============================================
// Start
// ============================================

initializeMap();

function filterMapPins(fit = false) {
    const query = document.getElementById("mapSearch").value.trim().toLowerCase();
    const matches = [];
    markers.forEach(marker => {
        if (!query || marker.searchText.includes(query)) {
            marker.addTo(map);
            matches.push(marker.getLatLng());
        } else map.removeLayer(marker);
    });
    if (peakCircle) {
        if (query) map.removeLayer(peakCircle);
        else peakCircle.addTo(map);
    }
    document.getElementById("mapSearchCount").textContent = query ? `${matches.length} matching pins` : "";
    if (fit && matches.length) map.fitBounds(matches, {padding: [30, 30], maxZoom: 16});
}
let searchTimer;
document.getElementById("mapSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => filterMapPins(true), 200);
});
const fullscreenButton = document.getElementById("fullscreenButton");
fullscreenButton.addEventListener("click", async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.querySelector(".map-container").requestFullscreen();
    } catch (_) {
        document.getElementById("statusText").textContent = "Full screen is unavailable in this browser view.";
    }
});
document.addEventListener("fullscreenchange", () => {
    fullscreenButton.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
    map.invalidateSize({pan: false});
});

// Sidebar content and viewport changes can resize the stretched map independently.
if (typeof ResizeObserver !== "undefined") {
    const mapResizeObserver = new ResizeObserver(() => {
        map.invalidateSize({pan: false});
    });
    mapResizeObserver.observe(document.getElementById("map"));
}

window.addEventListener("pagehide", saveSnapshot);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveSnapshot();
    else if (!isLoading) loadContacts();
});
document.getElementById("fitMapButton").addEventListener("click", () => {
    clearTimeout(searchTimer);
    document.getElementById("mapSearch").value = "";
    filterMapPins();
    if (markers.length) map.fitBounds(markers.map(marker => marker.getLatLng()), {padding: [30, 30], maxZoom: 16});
});

loadContacts();
