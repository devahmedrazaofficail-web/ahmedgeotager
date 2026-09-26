(function () {
    "use strict";

    const state = {
        file: null,
        objectUrl: null,
        outputUrl: null,
        outputBlob: null,
        outputName: "",
        map: null,
        marker: null,
        mapLocation: null,
        location: null,
        searchCache: new Map(),
        reverseCache: new Map(),
        lastGeocodeAt: 0,
        geocodeQueue: Promise.resolve(),
        isWriting: false
    };

    const acceptedExtensions = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
    const writableExtensions = new Set(["jpg", "jpeg"]);
    const elements = {};

    function cacheElements() {
        [
            "file-input", "upload-dropzone", "upload-section", "upload-error", "workspace", "photo-preview", "file-placeholder",
            "file-name", "file-details", "format-badge", "clear-button", "fullscreen-button", "search-form", "location-search",
            "search-button", "search-results", "map-message", "map", "location-name", "location-context", "use-map-button",
            "latitude", "longitude", "latitude-error", "longitude-error", "apply-coordinates", "altitude", "altitude-error",
            "direction", "direction-error", "gps-time", "gps-time-error", "title", "description", "keywords", "artist",
            "copyright", "date-taken", "write-button", "write-progress", "progress-label", "progress-step", "progress-bar",
            "operation-message", "download-button", "existing-details", "exif-status", "exif-list", "reset-dialog", "confirm-reset"
        ].forEach((id) => { elements[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = document.getElementById(id); });
    }

    function initialize() {
        cacheElements();
        bindEvents();
        renderExifRows({});
        if (!window.L) setMapMessage("The interactive map could not load. Coordinates and JPEG writing can still be used.", true);
    }

    function bindEvents() {
        elements.uploadDropzone.addEventListener("click", () => elements.fileInput.click());
        elements.fileInput.addEventListener("change", (event) => {
            const [file] = event.target.files || [];
            if (file) handleFileUpload(file);
            event.target.value = "";
        });
        elements.uploadDropzone.addEventListener("dragover", (event) => {
            event.preventDefault();
            elements.uploadDropzone.classList.add("is-dragging");
        });
        elements.uploadDropzone.addEventListener("dragleave", (event) => {
            if (!elements.uploadDropzone.contains(event.relatedTarget)) elements.uploadDropzone.classList.remove("is-dragging");
        });
        elements.uploadDropzone.addEventListener("drop", (event) => {
            event.preventDefault();
            elements.uploadDropzone.classList.remove("is-dragging");
            const [file] = event.dataTransfer.files || [];
            if (file) handleFileUpload(file);
        });
        elements.searchForm.addEventListener("submit", (event) => {
            event.preventDefault();
            searchLocation();
        });
        elements.applyCoordinates.addEventListener("click", applyCoordinateInputs);
        elements.useMapButton.addEventListener("click", useMapLocation);
        elements.fullscreenButton.addEventListener("click", toggleMapFullscreen);
        elements.writeButton.addEventListener("click", writeExifMetadata);
        elements.downloadButton.addEventListener("click", generateDownload);
        elements.clearButton.addEventListener("click", () => elements.resetDialog.showModal());
        elements.confirmReset.addEventListener("click", (event) => {
            if (event.submitter?.value === "cancel") return;
            resetTool();
        });
        [elements.latitude, elements.longitude].forEach((input) => {
            input.addEventListener("input", () => {
                clearFieldError(input);
                updateWriteAvailability();
            });
        });
        [elements.altitude, elements.direction, elements.gpsTime].forEach((input) => {
            input.addEventListener("input", () => clearFieldError(input));
            input.addEventListener("change", () => clearFieldError(input));
        });
        document.addEventListener("fullscreenchange", updateFullscreenLabel);
    }

    function showError(message) {
        elements.uploadError.textContent = message;
        elements.uploadError.hidden = false;
    }

    function clearUploadError() {
        elements.uploadError.textContent = "";
        elements.uploadError.hidden = true;
    }

    async function handleFileUpload(file) {
        clearUploadError();
        const extension = file.name.split(".").pop().toLowerCase();
        if (!acceptedExtensions.has(extension)) {
            showError("That file type is not supported. Choose a JPG, PNG, WebP, or HEIC image.");
            return;
        }
        if (file.size === 0) {
            showError("This file is empty. Choose a valid image file.");
            return;
        }

        clearImageResources();
        clearOutput();
        clearOperationMessage();
        clearCoordinateErrors();
        state.file = file;
        state.objectUrl = URL.createObjectURL(file);
        elements.photoPreview.hidden = true;
        elements.filePlaceholder.hidden = false;
        elements.fileName.textContent = file.name;
        elements.fileDetails.textContent = `${formatBytes(file.size)} · Loading image…`;
        elements.formatBadge.textContent = extension.toUpperCase();
        elements.formatBadge.classList.toggle("is-jpeg", writableExtensions.has(extension));
        elements.uploadSection.hidden = true;
        elements.workspace.hidden = false;
        elements.latitude.value = "";
        elements.longitude.value = "";
        elements.altitude.value = "";
        elements.direction.value = "";
        elements.gpsTime.value = "";
        elements.title.value = "";
        elements.description.value = "";
        elements.keywords.value = "";
        elements.artist.value = "";
        elements.copyright.value = "";
        elements.dateTaken.value = "";
        elements.locationName.textContent = "No location selected";
        elements.locationContext.textContent = "Choose a point on the map or search for a place";
        elements.useMapButton.disabled = true;
        elements.exifStatus.textContent = "Reading…";
        elements.exifStatus.classList.remove("is-detected");
        renderExifRows({});
        updateWriteAvailability();
        initializeMap();
        if (state.map) window.setTimeout(() => state.map.invalidateSize(), 80);

        try {
            const imageInfo = await loadPreview(state.objectUrl);
            if (state.file !== file) return;
            elements.fileDetails.textContent = `${formatBytes(file.size)} · ${imageInfo.width} × ${imageInfo.height} px · ${extension.toUpperCase()} · Preview ready`;
            await parseExif(file, imageInfo);
        } catch (error) {
            console.error("Image preview or EXIF parsing failed:", error);
            if (state.file !== file) return;
            elements.fileDetails.textContent = `${formatBytes(file.size)} · ${extension.toUpperCase()} · Preview unavailable`;
            elements.exifStatus.textContent = "Could not read";
            renderExifRows({});
            showOperationMessage("This image could not be decoded by your browser. Try another image or a supported JPEG.", "error");
        }
    }

    function loadPreview(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                elements.photoPreview.src = url;
                elements.photoPreview.hidden = false;
                elements.filePlaceholder.hidden = true;
                resolve({ width: image.naturalWidth, height: image.naturalHeight });
            };
            image.onerror = () => reject(new Error("Image decode failed"));
            image.src = url;
        });
    }

    async function parseExif(file, imageInfo) {
        if (!window.exifr) {
            elements.exifStatus.textContent = "Parser unavailable";
            showOperationMessage("The EXIF reader did not load. Check your connection and reload the page to read photo metadata.", "error");
            return;
        }
        try {
            const [metadata, gps] = await Promise.all([
                window.exifr.parse(file, { tiff: true, exif: true, gps: true, ihdr: true }),
                window.exifr.gps(file)
            ]);
            if (state.file !== file) return;
            const data = metadata || {};
            renderExifRows(data, imageInfo, gps);
            elements.exifStatus.textContent = "Read from image";
            if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
                elements.exifStatus.textContent = "GPS location detected";
                elements.exifStatus.classList.add("is-detected");
                elements.latitude.value = String(gps.latitude);
                elements.longitude.value = String(gps.longitude);
                state.mapLocation = { lat: gps.latitude, lon: gps.longitude };
                setMapLocation(gps.latitude, gps.longitude, { zoom: 13, reverse: true });
                const altitude = gpsAltitudeFromExif(data);
                if (altitude !== null) elements.altitude.value = String(altitude);
            } else {
                elements.exifStatus.textContent = Object.keys(data).length ? "Metadata found" : "No EXIF metadata found";
            }
            updateWriteAvailability();
        } catch (error) {
            console.error("EXIF parsing failed:", error);
            elements.exifStatus.textContent = "Could not read";
            renderExifRows({}, imageInfo);
        }
    }

    function renderExifRows(metadata, imageInfo, gps) {
        const rows = [
            ["Camera make", metadata.Make],
            ["Camera model", metadata.Model],
            ["Date taken", formatExifDate(metadata.DateTimeOriginal || metadata.CreateDate)],
            ["Orientation", metadata.Orientation],
            ["GPS latitude", gps?.latitude ?? metadata.latitude ?? metadata.GPSLatitude],
            ["GPS longitude", gps?.longitude ?? metadata.longitude ?? metadata.GPSLongitude],
            ["GPS altitude", gpsAltitudeFromExif(metadata) == null ? null : `${gpsAltitudeFromExif(metadata)} m`],
            ["Software", metadata.Software],
            ["Image width", imageInfo?.width || metadata.ImageWidth || metadata.ExifImageWidth ? `${imageInfo?.width || metadata.ImageWidth || metadata.ExifImageWidth} px` : null],
            ["Image height", imageInfo?.height || metadata.ImageHeight || metadata.ExifImageHeight ? `${imageInfo?.height || metadata.ImageHeight || metadata.ExifImageHeight} px` : null]
        ];
        elements.exifList.replaceChildren();
        const populated = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
        if (!populated.length) {
            const empty = document.createElement("div");
            empty.className = "exif-empty";
            empty.textContent = "No readable camera or GPS fields were found in this image.";
            elements.exifList.append(empty);
            return;
        }
        populated.forEach(([label, value]) => {
            const term = document.createElement("dt");
            const definition = document.createElement("dd");
            term.textContent = label;
            definition.textContent = typeof value === "object" ? formatExifDate(value) : String(value);
            elements.exifList.append(term, definition);
        });
    }

    function formatExifDate(value) {
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toLocaleString();
        if (Array.isArray(value)) return value.join(", ");
        return value == null ? "" : String(value);
    }

    function gpsAltitudeFromExif(metadata) {
        const altitude = Number(metadata.GPSAltitude);
        if (!Number.isFinite(altitude)) return null;
        const reference = metadata.GPSAltitudeRef;
        const belowSeaLevel = reference === 1 || reference?.[0] === 1 || String(reference).toLowerCase().includes("below");
        return belowSeaLevel ? -Math.abs(altitude) : Math.abs(altitude);
    }

    function initializeMap() {
        if (state.map || !window.L) return;
        try {
            state.map = window.L.map(elements.map, { zoomControl: true, scrollWheelZoom: true }).setView([20, 0], 2);
            window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors"
            }).addTo(state.map);
            state.map.on("click", (event) => setMapLocation(event.latlng.lat, event.latlng.lng, { zoom: state.map.getZoom(), reverse: true }));
            setMapMessage("Search for a place or click the map to choose a point.");
        } catch (error) {
            console.error("Map initialization failed:", error);
            setMapMessage("The map could not start. You can still enter coordinates manually.", true);
        }
    }

    function setMapLocation(latitude, longitude, options = {}) {
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        state.mapLocation = { lat: latitude, lon: longitude };
        elements.latitude.value = formatCoordinate(latitude);
        elements.longitude.value = formatCoordinate(longitude);
        clearFieldError(elements.latitude);
        clearFieldError(elements.longitude);
        elements.locationName.textContent = "Selected coordinates";
        elements.locationContext.textContent = `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
        elements.useMapButton.disabled = false;
        updateWriteAvailability();
        if (state.map) {
            const point = [latitude, longitude];
            state.map.setView(point, options.zoom || Math.max(state.map.getZoom(), 13));
            if (!state.marker) {
                state.marker = window.L.marker(point, { draggable: true }).addTo(state.map);
                state.marker.on("dragend", () => {
                    const moved = state.marker.getLatLng();
                    setMapLocation(moved.lat, moved.lng, { zoom: state.map.getZoom(), reverse: true });
                });
            } else {
                state.marker.setLatLng(point);
            }
        }
        setMapMessage(options.message || "Coordinates selected. Drag the marker or enter precise values.");
        if (options.reverse) reverseGeocode(latitude, longitude);
    }

    function setMapMessage(message, isError = false) {
        elements.mapMessage.textContent = message;
        elements.mapMessage.classList.toggle("is-error", isError);
    }

    function applyCoordinateInputs() {
        clearCoordinateErrors();
        const latitude = validateCoordinate(elements.latitude, -90, 90, "Latitude");
        const longitude = validateCoordinate(elements.longitude, -180, 180, "Longitude");
        if (latitude === null || longitude === null) return;
        state.location = null;
        setLocationLabels(null);
        setMapLocation(latitude, longitude, { zoom: 13, reverse: true });
    }

    function validateCoordinate(input, minimum, maximum, label) {
        const raw = input.value.trim();
        if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
            setFieldError(input, `${label} must be a decimal number.`);
            return null;
        }
        const fraction = raw.split(".")[1] || "";
        if (fraction.length > 12) {
            setFieldError(input, `${label} supports up to 12 decimal places.`);
            return null;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < minimum || value > maximum) {
            setFieldError(input, `${label} must be between ${minimum} and ${maximum}.`);
            return null;
        }
        return value;
    }

    function useMapLocation() {
        if (!state.mapLocation) return;
        elements.latitude.value = formatCoordinate(state.mapLocation.lat);
        elements.longitude.value = formatCoordinate(state.mapLocation.lon);
        clearCoordinateErrors();
        updateWriteAvailability();
    }

    async function searchLocation() {
        const query = elements.locationSearch.value.trim();
        elements.searchResults.hidden = true;
        elements.searchResults.replaceChildren();
        if (query.length < 2) {
            setMapMessage("Enter at least two characters to search.", true);
            return;
        }
        elements.searchButton.disabled = true;
        setMapMessage("Searching OpenStreetMap…");
        try {
            const results = await geocodeRequest("search", query);
            if (!results.length) {
                setMapMessage("No places found. Try a nearby city or a more specific address.", true);
                return;
            }
            renderSearchResults(results);
            setMapMessage(`${results.length} matching ${results.length === 1 ? "place" : "places"} found. Choose one to set the marker.`);
        } catch (error) {
            console.error("Location search failed:", error);
            setMapMessage("Location search is unavailable right now. Check your connection and try again.", true);
        } finally {
            elements.searchButton.disabled = false;
        }
    }

    function renderSearchResults(results) {
        elements.searchResults.replaceChildren();
        results.slice(0, 6).forEach((result) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "search-result";
            const name = document.createElement("strong");
            const context = document.createElement("span");
            name.textContent = result.name || result.display_name.split(",")[0];
            context.textContent = result.display_name;
            button.append(name, context);
            button.addEventListener("click", () => {
                const latitude = Number(result.lat);
                const longitude = Number(result.lon);
                elements.searchResults.hidden = true;
                setMapLocation(latitude, longitude, { zoom: Math.max(13, Number(result.zoom) || 13), message: "Place selected from search." });
                state.location = result.address || null;
                setLocationLabels(state.location, result.name || result.display_name.split(",")[0]);
            });
            elements.searchResults.append(button);
        });
        elements.searchResults.hidden = false;
    }

    async function reverseGeocode(latitude, longitude) {
        const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        if (state.reverseCache.has(key)) {
            state.location = state.reverseCache.get(key);
            setLocationLabels(state.location);
            return;
        }
        try {
            const results = await geocodeRequest("reverse", `${latitude},${longitude}`);
            const location = results.address || null;
            state.reverseCache.set(key, location);
            if (state.mapLocation && Math.abs(state.mapLocation.lat - latitude) < 0.000001 && Math.abs(state.mapLocation.lon - longitude) < 0.000001) {
                state.location = location;
                setLocationLabels(location, results.name || results.display_name?.split(",")[0]);
            }
        } catch (error) {
            console.info("Reverse geocoding unavailable:", error);
            setMapMessage("Coordinates are set. A place name could not be retrieved right now.");
        }
    }

    async function geocodeRequest(mode, query) {
        const key = `${mode}:${query.toLowerCase()}`;
        const cache = mode === "search" ? state.searchCache : state.reverseCache;
        if (cache.has(key)) return cache.get(key);
        const request = async () => {
            const delay = Math.max(0, 1100 - (Date.now() - state.lastGeocodeAt));
            if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
            const url = new URL(`https://nominatim.openstreetmap.org/${mode}`);
            if (mode === "search") {
                url.searchParams.set("format", "jsonv2");
                url.searchParams.set("addressdetails", "1");
                url.searchParams.set("limit", "6");
                url.searchParams.set("q", query);
            } else {
                const [latitude, longitude] = query.split(",");
                url.searchParams.set("format", "jsonv2");
                url.searchParams.set("addressdetails", "1");
                url.searchParams.set("lat", latitude);
                url.searchParams.set("lon", longitude);
            }
            state.lastGeocodeAt = Date.now();
            const response = await fetch(url, { headers: { Accept: "application/json" } });
            if (!response.ok) throw new Error(`Geocoding request returned ${response.status}`);
            const result = await response.json();
            cache.set(key, result);
            return result;
        };
        const pending = state.geocodeQueue.then(request, request);
        state.geocodeQueue = pending.catch(() => { });
        return pending;
    }

    function setLocationLabels(address, fallbackName) {
        if (!address) {
            elements.locationName.textContent = fallbackName || "Selected coordinates";
            if (state.mapLocation) elements.locationContext.textContent = `${formatCoordinate(state.mapLocation.lat)}, ${formatCoordinate(state.mapLocation.lon)}`;
            return;
        }
        const name = fallbackName || address.amenity || address.tourism || address.leisure || address.shop || address.road || address.neighbourhood || address.suburb || address.city || address.town || address.village || "Selected place";
        const city = address.city || address.town || address.village || address.municipality;
        const region = address.state || address.region || address.province;
        const country = address.country;
        const context = [city && city !== name ? city : null, region && region !== city ? region : null, country].filter(Boolean).join(", ");
        elements.locationName.textContent = name;
        elements.locationContext.textContent = [context, state.mapLocation ? `${formatCoordinate(state.mapLocation.lat)}, ${formatCoordinate(state.mapLocation.lon)}` : null].filter(Boolean).join(" · ");
    }

    function toggleMapFullscreen() {
        if (!elements.map.requestFullscreen) {
            setMapMessage("Fullscreen is not available in this browser.", true);
            return;
        }
        if (document.fullscreenElement === elements.map) document.exitFullscreen?.();
        else elements.map.requestFullscreen().catch((error) => {
            console.error("Map fullscreen failed:", error);
            setMapMessage("The map could not enter fullscreen.", true);
        });
    }

    function updateFullscreenLabel() {
        const isFullscreen = document.fullscreenElement === elements.map;
        elements.fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit map fullscreen" : "Enter map fullscreen");
        if (state.map) window.setTimeout(() => state.map.invalidateSize(), 80);
    }

    function updateWriteAvailability() {
        const extension = state.file?.name.split(".").pop().toLowerCase();
        elements.writeButton.disabled = !state.file || !writableExtensions.has(extension) || state.isWriting;
    }

    function setFieldError(input, message) {
        const errorElement = document.getElementById(`${input.id}-error`);
        input.setAttribute("aria-invalid", "true");
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.hidden = false;
        }
    }

    function clearFieldError(input) {
        const errorElement = document.getElementById(`${input.id}-error`);
        input.removeAttribute("aria-invalid");
        if (errorElement) {
            errorElement.textContent = "";
            errorElement.hidden = true;
        }
    }

    function clearCoordinateErrors() {
        [elements.latitude, elements.longitude, elements.altitude, elements.direction, elements.gpsTime].forEach(clearFieldError);
    }

    function validateAllFields() {
        clearCoordinateErrors();
        const latitude = validateCoordinate(elements.latitude, -90, 90, "Latitude");
        const longitude = validateCoordinate(elements.longitude, -180, 180, "Longitude");
        let valid = latitude !== null && longitude !== null;
        if (elements.altitude.value.trim() && !isValidDecimal(elements.altitude.value, -12000, 100000, 3)) {
            setFieldError(elements.altitude, "Enter an altitude between −12,000 and 100,000 meters.");
            valid = false;
        }
        if (elements.direction.value.trim() && !isValidDecimal(elements.direction.value, 0, 359.999999999, 12)) {
            setFieldError(elements.direction, "Direction must be between 0° and less than 360°.");
            valid = false;
        }
        if (elements.gpsTime.value && !parseDateTimeLocal(elements.gpsTime.value)) {
            setFieldError(elements.gpsTime, "Enter a valid GPS timestamp in UTC.");
            valid = false;
        }
        return valid ? { latitude, longitude } : null;
    }

    function isValidDecimal(raw, minimum, maximum, maxFractionDigits) {
        const value = raw.trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return false;
        if ((value.split(".")[1] || "").length > maxFractionDigits) return false;
        const number = Number(value);
        return Number.isFinite(number) && number >= minimum && number <= maximum;
    }

    function decimalToDMS(decimalText) {
        const negative = decimalText.trim().startsWith("-");
        const unsigned = decimalText.trim().replace(/^[+-]/, "");
        const [wholeText, fractionalText = ""] = unsigned.split(".");
        const scale = 10n ** BigInt(fractionalText.length);
        const whole = BigInt(wholeText || "0");
        const fraction = BigInt(fractionalText || "0");
        const total = whole * scale + fraction;
        const degrees = total / scale;
        const remaining = total % scale;
        const minutesNumerator = remaining * 60n;
        const minutes = minutesNumerator / scale;
        const secondsNumerator = (minutesNumerator % scale) * 60n;
        const divisor = greatestCommonDivisor(secondsNumerator, scale);
        return {
            negative,
            dms: [[Number(degrees), 1], [Number(minutes), 1], [Number(secondsNumerator / divisor), Number(scale / divisor)]]
        };
    }

    function greatestCommonDivisor(left, right) {
        let a = left;
        let b = right;
        while (b !== 0n) [a, b] = [b, a % b];
        return a || 1n;
    }

    async function writeExifMetadata() {
        if (!state.file || state.isWriting) return;
        const extension = state.file.name.split(".").pop().toLowerCase();
        if (!writableExtensions.has(extension)) {
            showOperationMessage("GPS metadata writing is currently supported for JPEG images. This image format can be previewed, but reliable EXIF GPS writing is not available.", "error");
            return;
        }
        if (!window.piexif || !window.exifr) {
            showOperationMessage("The metadata tools did not load. Check your connection and reload this page before writing.", "error");
            return;
        }
        const coordinates = validateAllFields();
        if (!coordinates) {
            showOperationMessage("Check the highlighted fields before writing metadata.", "error");
            return;
        }
        if (!state.mapLocation || state.mapLocation.lat !== coordinates.latitude || state.mapLocation.lon !== coordinates.longitude) {
            state.location = null;
            setMapLocation(coordinates.latitude, coordinates.longitude, { zoom: 13 });
            setLocationLabels(null);
        }

        state.isWriting = true;
        updateWriteAvailability();
        clearOutput();
        clearOperationMessage();
        elements.writeProgress.hidden = false;
        try {
            updateProgress("Reading original image", 1, 5);
            await nextPaint();
            const originalDataUrl = await readFileAsDataUrl(state.file);
            updateProgress("Validating coordinates", 2, 5);
            await nextPaint();
            const exif = window.piexif.load(originalDataUrl);
            exif["0th"] ||= {};
            exif.Exif ||= {};
            exif.GPS ||= {};
            writeGpsTags(exif.GPS);
            writeOptionalMetadata(exif);
            const exifBytes = window.piexif.dump(exif);
            updateProgress("Writing EXIF metadata", 3, 5);
            await nextPaint();
            const writtenDataUrl = window.piexif.insert(exifBytes, originalDataUrl);
            const generatedBlob = await dataUrlToBlob(writtenDataUrl);
            const generatedName = makeOutputFilename(state.file.name);
            updateProgress("Verifying GPS metadata", 4, 5);
            await nextPaint();
            const verified = await verifyExifMetadata(generatedBlob, coordinates);
            if (!verified) throw new Error("GPS metadata could not be confirmed after writing");
            state.outputBlob = generatedBlob;
            state.outputUrl = URL.createObjectURL(generatedBlob);
            state.outputName = generatedName;
            updateProgress("Ready to download", 5, 5);
            showOperationMessage("✓ GPS metadata successfully written and verified", "success");
            elements.downloadButton.hidden = false;
        } catch (error) {
            console.error("EXIF writing or verification failed:", error);
            showOperationMessage("Metadata verification failed. The image was not marked as successfully geotagged. Check that the JPEG is valid and try again.", "error");
            clearOutput();
        } finally {
            state.isWriting = false;
            updateWriteAvailability();
        }
    }

    function writeGpsTags(gps) {
        const tags = window.piexif.GPSIFD;
        const latitude = decimalToDMS(elements.latitude.value.trim());
        const longitude = decimalToDMS(elements.longitude.value.trim());
        gps[tags.GPSVersionID] = [2, 3, 0, 0];
        gps[tags.GPSLatitudeRef] = latitude.negative ? "S" : "N";
        gps[tags.GPSLatitude] = latitude.dms;
        gps[tags.GPSLongitudeRef] = longitude.negative ? "W" : "E";
        gps[tags.GPSLongitude] = longitude.dms;

        const altitudeText = elements.altitude.value.trim();
        if (altitudeText) {
            const altitude = decimalToRational(altitudeText, true);
            gps[tags.GPSAltitude] = [altitude.numerator, altitude.denominator];
            gps[tags.GPSAltitudeRef] = Number(altitudeText) < 0 ? 1 : 0;
        }
        const directionText = elements.direction.value.trim();
        if (directionText) {
            const direction = decimalToRational(directionText);
            gps[tags.GPSImgDirectionRef] = "T";
            gps[tags.GPSImgDirection] = [direction.numerator, direction.denominator];
        }
        if (elements.gpsTime.value) {
            const dateParts = parseDateTimeLocal(elements.gpsTime.value);
            gps[tags.GPSDateStamp] = `${dateParts.year}:${dateParts.month}:${dateParts.day}`;
            gps[tags.GPSTimeStamp] = [
                [Number(dateParts.hour), 1],
                [Number(dateParts.minute), 1],
                [Number(dateParts.second), 1]
            ];
        }
    }

    function writeOptionalMetadata(exif) {
        const imageTags = window.piexif.ImageIFD;
        const exifTags = window.piexif.ExifIFD;
        const title = elements.title.value.trim();
        const description = elements.description.value.trim();
        const artist = elements.artist.value.trim();
        const copyright = elements.copyright.value.trim();
        const keywords = elements.keywords.value.trim();
        if (title) exif["0th"][imageTags.XPTitle] = toUtf16LeBytes(title);
        if (description) exif["0th"][imageTags.ImageDescription] = description;
        if (artist) {
            exif["0th"][imageTags.Artist] = artist;
            exif["0th"][imageTags.XPAuthor] = toUtf16LeBytes(artist);
        }
        if (copyright) exif["0th"][imageTags.Copyright] = copyright;
        if (keywords) exif["0th"][imageTags.XPKeywords] = toUtf16LeBytes(keywords);
        if (elements.dateTaken.value) {
            const parts = parseDateTimeLocal(elements.dateTaken.value);
            exif.Exif[exifTags.DateTimeOriginal] = `${parts.year}:${parts.month}:${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
        }
    }

    function decimalToRational(decimalText, absolute = false) {
        const clean = decimalText.trim();
        const negative = clean.startsWith("-");
        const unsigned = clean.replace(/^[+-]/, "");
        const [whole, fraction = ""] = unsigned.split(".");
        const denominator = 10n ** BigInt(fraction.length);
        let numerator = BigInt(whole || "0") * denominator + BigInt(fraction || "0");
        if (negative && !absolute) numerator = -numerator;
        const divisor = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
        return { numerator: Number(numerator / divisor), denominator: Number(denominator / divisor) };
    }

    function toUtf16LeBytes(value) {
        const bytes = [];
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            bytes.push(code & 0xff, code >> 8);
        }
        bytes.push(0, 0);
        return bytes;
    }

    function parseDateTimeLocal(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
        if (!match) return null;
        const [, year, month, day, hour, minute, second = "00"] = match;
        const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
        if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() + 1 !== Number(month) || check.getUTCDate() !== Number(day) || check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute) || check.getUTCSeconds() !== Number(second)) return null;
        return { year, month, day, hour, minute, second };
    }

    async function verifyExifMetadata(blob, expected) {
        const gps = await window.exifr.gps(blob);
        if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) return false;
        const tolerance = 5e-10;
        return Math.abs(gps.latitude - expected.latitude) <= tolerance && Math.abs(gps.longitude - expected.longitude) <= tolerance;
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image data"));
            reader.onerror = () => reject(reader.error || new Error("Could not read image data"));
            reader.readAsDataURL(file);
        });
    }

    async function dataUrlToBlob(dataUrl) {
        const response = await fetch(dataUrl);
        return response.blob();
    }

    function updateProgress(label, step, total) {
        elements.progressLabel.textContent = label;
        elements.progressStep.textContent = `${step} / ${total}`;
        elements.progressBar.style.width = `${Math.round(step / total * 100)}%`;
    }

    function nextPaint() {
        return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    function showOperationMessage(message, type) {
        elements.operationMessage.textContent = message;
        elements.operationMessage.className = `operation-message is-${type}`;
        elements.operationMessage.hidden = false;
    }

    function clearOperationMessage() {
        elements.operationMessage.textContent = "";
        elements.operationMessage.hidden = true;
        elements.operationMessage.className = "operation-message";
    }

    function clearOutput() {
        if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
        state.outputUrl = null;
        state.outputBlob = null;
        state.outputName = "";
        elements.downloadButton.hidden = true;
        elements.writeProgress.hidden = true;
        elements.progressBar.style.width = "0%";
    }

    function generateDownload() {
        if (!state.outputBlob || !state.outputUrl || !state.outputName) return;
        const anchor = document.createElement("a");
        anchor.href = state.outputUrl;
        anchor.download = state.outputName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    }

    function makeOutputFilename(filename) {
        const stem = filename.replace(/\.[^.]+$/, "");
        return `${stem}-geotagged.jpg`;
    }

    function resetTool() {
        clearImageResources();
        clearOutput();
        clearUploadError();
        clearOperationMessage();
        clearCoordinateErrors();
        if (state.marker && state.map) state.map.removeLayer(state.marker);
        state.marker = null;
        state.mapLocation = null;
        state.location = null;
        state.file = null;
        state.isWriting = false;
        elements.fileInput.value = "";
        elements.fileName.textContent = "";
        elements.fileDetails.textContent = "";
        elements.photoPreview.removeAttribute("src");
        elements.photoPreview.hidden = true;
        elements.filePlaceholder.hidden = false;
        elements.formatBadge.textContent = "";
        elements.formatBadge.classList.remove("is-jpeg");
        [elements.latitude, elements.longitude, elements.altitude, elements.direction, elements.gpsTime, elements.title, elements.description, elements.keywords, elements.artist, elements.copyright, elements.dateTaken].forEach((input) => { input.value = ""; });
        elements.locationName.textContent = "No location selected";
        elements.locationContext.textContent = "Choose a point on the map or search for a place";
        elements.useMapButton.disabled = true;
        elements.searchResults.replaceChildren();
        elements.searchResults.hidden = true;
        elements.locationSearch.value = "";
        elements.exifStatus.textContent = "Not read yet";
        elements.exifStatus.classList.remove("is-detected");
        renderExifRows({});
        elements.workspace.hidden = true;
        elements.uploadSection.hidden = false;
        setMapMessage("Search for a place or click the map to choose a point.");
        if (state.map) state.map.setView([20, 0], 2);
        updateWriteAvailability();
        elements.uploadDropzone.focus();
    }

    function clearImageResources() {
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = null;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        const units = ["KB", "MB", "GB"];
        let size = bytes / 1024;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit += 1;
        }
        return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
    }

    function formatCoordinate(value) {
        if (Object.is(value, -0)) return "-0";
        return Number(value).toFixed(12).replace(/\.?0+$/, "");
    }

    document.addEventListener("DOMContentLoaded", initialize);
})();