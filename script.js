(function () {
    "use strict";

    const state = {
        file: null,
        files: [],
        objectUrl: null,
        outputUrl: null,
        outputBlob: null,
        outputName: "",
        outputs: [],
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
            "operation-message", "download-options", "output-format", "compression-target", "download-button", "batch-download-button", "batch-file-list", "format-limit-copy", "existing-details", "exif-status", "exif-list", "reset-dialog", "confirm-reset"
        ].forEach((id) => { elements[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = document.getElementById(id); });
    }

    function initialize() {
        cacheElements();
        bindEvents();
        renderExifRows({});
        if (!window.L) setMapMessage("The interactive map could not load. Coordinates can still be entered manually.", true);
    }

    function bindEvents() {
        elements.uploadDropzone.addEventListener("click", () => elements.fileInput.click());
        elements.fileInput.addEventListener("change", (event) => {
            const files = Array.from(event.target.files || []);
            if (files.length) handleFileUpload(files);
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
            const files = Array.from(event.dataTransfer.files || []);
            if (files.length) handleFileUpload(files);
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
        elements.batchDownloadButton.addEventListener("click", downloadBatch);
        elements.outputFormat.addEventListener("change", updateDownloadOptions);
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

    async function handleFileUpload(files) {
        clearUploadError();
        const invalidFile = files.find((file) => !acceptedExtensions.has(file.name.split(".").pop().toLowerCase()) || file.size === 0);
        if (invalidFile) {
            showError(`${invalidFile.name} is empty or unsupported. Choose JPG, PNG, WebP, or HEIC images.`);
            return;
        }
        const [file] = files;
        const extension = file.name.split(".").pop().toLowerCase();

        clearImageResources();
        clearOutput();
        clearOperationMessage();
        clearCoordinateErrors();
        state.files = files;
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
            const selectionDetails = files.length > 1 ? ` · ${files.length} images selected` : "";
            elements.fileDetails.textContent = `${formatBytes(file.size)} · ${imageInfo.width} × ${imageInfo.height} px · ${extension.toUpperCase()} · Preview ready${selectionDetails}`;
            renderBatchFiles(files);
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
        elements.writeButton.disabled = !state.files.length || state.isWriting;
        elements.writeButton.querySelector("span").textContent = state.files.length > 1
            ? `Geotag ${state.files.length} photos`
            : "Write GPS metadata";
    }

    function renderBatchFiles(files) {
        elements.batchFileList.replaceChildren();
        elements.batchFileList.hidden = files.length < 2;
        if (files.length < 2) return;
        files.forEach((file, index) => {
            const row = document.createElement("div");
            const name = document.createElement("span");
            const status = document.createElement("span");
            row.className = "batch-file-row";
            name.className = "batch-file-name";
            name.textContent = file.name;
            status.className = "batch-file-status";
            status.textContent = "Ready";
            status.dataset.batchIndex = String(index);
            row.append(name, status);
            elements.batchFileList.append(row);
        });
    }

    function updateBatchFileStatus(index, message, isError = false) {
        const status = elements.batchFileList.querySelector(`[data-batch-index="${index}"]`);
        if (!status) return;
        status.textContent = message;
        status.classList.toggle("is-error", isError);
        status.classList.toggle("is-success", !isError && message !== "Ready");
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
        if (!state.files.length || state.isWriting) return;
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
            renderBatchFiles(state.files);
            let failed = 0;
            for (let index = 0; index < state.files.length; index += 1) {
                const file = state.files[index];
                const progress = (label, step, total) => {
                    updateProgress(`Photo ${index + 1}/${state.files.length}: ${label}`, index * total + step, state.files.length * total);
                };
                try {
                    const output = await createGeotaggedImage(file, coordinates, progress);
                    state.outputs.push({ ...output, sourceIndex: index });
                    updateBatchFileStatus(index, `Geotagged · ${formatBytes(output.blob.size)}`);
                } catch (error) {
                    failed += 1;
                    console.error(`Could not geotag ${file.name}:`, error);
                    updateBatchFileStatus(index, "Failed", true);
                }
                await nextPaint();
            }
            if (!state.outputs.length) throw new Error("No images could be geotagged. Check the selected files and try again.");
            if (state.outputs.length === 1 && state.files.length === 1) {
                const [output] = state.outputs;
                state.outputBlob = output.blob;
                state.outputName = output.name;
                state.outputUrl = URL.createObjectURL(output.blob);
                elements.downloadOptions.hidden = false;
                elements.downloadButton.hidden = false;
                elements.batchDownloadButton.hidden = true;
                elements.formatLimitCopy.textContent = "GPS metadata is embedded and verified in JPEG, PNG, and WebP downloads. Some photo apps may not display GPS tags in PNG or WebP.";
            } else {
                elements.downloadOptions.hidden = false;
                elements.downloadButton.hidden = true;
                elements.batchDownloadButton.hidden = false;
                elements.formatLimitCopy.textContent = "Choose an image format and optional maximum size per photo, then download the batch as a ZIP.";
            }
            updateDownloadOptions();
            updateProgress("Batch complete", state.files.length, state.files.length);
            showOperationMessage(
                failed ? `Geotagged ${state.outputs.length} of ${state.files.length} photos. Failed images are marked in the list.` : state.outputs.length === 1 ? "GPS metadata successfully written and verified" : `GPS metadata successfully written and verified for all ${state.outputs.length} photos.`,
                failed ? "error" : "success"
            );
        } catch (error) {
            console.error("EXIF writing or verification failed:", error);
            showOperationMessage(error.message || "Metadata verification failed. Check that the image is valid and try again.", "error");
            clearOutput();
        } finally {
            state.isWriting = false;
            updateWriteAvailability();
        }
    }

    async function createGeotaggedImage(file, coordinates, onProgress) {
        let temporaryUrl = null;
        try {
            onProgress("Preparing image", 1, 5);
            await nextPaint();
            const extension = file.name.split(".").pop().toLowerCase();
            let originalDataUrl;
            if (writableExtensions.has(extension)) {
                originalDataUrl = await readFileAsDataUrl(file);
            } else {
                temporaryUrl = URL.createObjectURL(file);
                originalDataUrl = await convertImageToJpegDataUrl(temporaryUrl);
                URL.revokeObjectURL(temporaryUrl);
                temporaryUrl = null;
            }
            onProgress("Validating coordinates", 2, 5);
            await nextPaint();
            const exif = window.piexif.load(originalDataUrl);
            exif["0th"] ||= {};
            exif.Exif ||= {};
            exif.GPS ||= {};
            writeGpsTags(exif.GPS);
            writeOptionalMetadata(exif);
            const exifBytes = window.piexif.dump(exif);
            onProgress("Writing EXIF metadata", 3, 5);
            await nextPaint();
            const writtenDataUrl = window.piexif.insert(exifBytes, originalDataUrl);
            const blob = await dataUrlToBlob(writtenDataUrl);
            onProgress("Verifying GPS metadata", 4, 5);
            await nextPaint();
            if (!await verifyExifMetadata(blob, coordinates)) throw new Error("GPS metadata could not be confirmed after writing");
            onProgress("Ready", 5, 5);
            return { blob, name: makeOutputFilename(file.name) };
        } finally {
            if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
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
        state.outputs = [];
        elements.downloadButton.hidden = true;
        elements.batchDownloadButton.hidden = true;
        elements.downloadOptions.hidden = true;
        elements.formatLimitCopy.textContent = "GPS metadata will be embedded in the selected JPEG, PNG, or WebP download.";
        elements.writeProgress.hidden = true;
        elements.progressBar.style.width = "0%";
    }

    function updateDownloadOptions() {
        const format = elements.outputFormat.value;
        const labels = { jpeg: "geotagged JPEG", png: "geotagged PNG", webp: "geotagged WebP" };
        elements.downloadButton.querySelector("span").textContent = `Download ${labels[format]}`;
        elements.batchDownloadButton.querySelector("span").textContent = `Download all as ZIP (${format.toUpperCase()})`;
        const hint = state.files.length > 1
            ? "Leave blank to keep the current quality. The maximum size applies to each exported photo. JPEG and WebP reduce quality; PNG is resized."
            : "Leave blank to keep the current quality. JPEG and WebP reduce quality; PNG is resized.";
        document.getElementById("compression-hint").textContent = hint;
    }

    async function generateDownload() {
        if (!state.outputBlob || !state.outputUrl || !state.outputName) return;
        const format = elements.outputFormat.value;
        const targetText = elements.compressionTarget.value.trim();
        const targetKb = targetText ? Number(targetText) : null;
        if (targetKb !== null && (!Number.isFinite(targetKb) || targetKb <= 0 || targetKb > Number.MAX_SAFE_INTEGER / 1024)) {
            showOperationMessage("Enter a valid maximum file size greater than 0 KB.", "error");
            elements.compressionTarget.focus();
            return;
        }
        let downloadUrl = state.outputUrl;
        let downloadName = state.outputName;
        if (format !== "jpeg" || targetKb !== null) {
            elements.downloadButton.disabled = true;
            try {
                const converted = await createDownloadOutput({ blob: state.outputBlob, name: state.outputName }, format, targetKb);
                downloadUrl = URL.createObjectURL(converted.blob);
                downloadName = converted.name;
                if (targetKb !== null) {
                    showOperationMessage(`Download compressed to ${formatBytes(converted.blob.size)} (maximum ${formatBytes(targetKb * 1024)}).`, "success");
                }
            } catch (error) {
                showOperationMessage(error.message || "The image could not be converted to the selected format.", "error");
                elements.downloadButton.disabled = false;
                return;
            }
            elements.downloadButton.disabled = false;
        }
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = downloadName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        if (downloadUrl !== state.outputUrl) window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }

    async function createDownloadOutput(output, format, targetKb) {
        if (format === "jpeg" && targetKb === null) return output;
        const sourceUrl = URL.createObjectURL(output.blob);
        try {
            const image = await loadImage(sourceUrl);
            const gps = await window.exifr.gps(output.blob);
            const exifTiff = await extractExifTiff(output.blob);
            let taggedBlob;
            if (targetKb !== null) {
                taggedBlob = await createTargetSizeImage(image, format, targetKb * 1024, exifTiff);
            } else {
                const canvas = document.createElement("canvas");
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("Your browser could not prepare this image for export.");
                context.drawImage(image, 0, 0);
                const mimeType = format === "png" ? "image/png" : "image/webp";
                const convertedBlob = await canvasToBlob(canvas, mimeType, 0.92);
                taggedBlob = await attachExif(convertedBlob, format, exifTiff, image.naturalWidth, image.naturalHeight);
            }
            const verified = format === "webp"
                ? await verifyWebpMetadata(taggedBlob, gps)
                : await verifyExifMetadata(taggedBlob, gps);
            if (!verified) throw new Error(`GPS metadata could not be verified in the ${format.toUpperCase()} export.`);
            return {
                blob: taggedBlob,
                name: format === "jpeg" ? output.name : output.name.replace(/\.jpe?g$/i, `.${format}`)
            };
        } finally {
            URL.revokeObjectURL(sourceUrl);
        }
    }

    async function downloadBatch() {
        if (!state.outputs.length) return;
        if (!window.JSZip) {
            showOperationMessage("The ZIP tool did not load. Check your connection and reload the page before downloading the batch.", "error");
            return;
        }
        const format = elements.outputFormat.value;
        const targetText = elements.compressionTarget.value.trim();
        const targetKb = targetText ? Number(targetText) : null;
        if (targetKb !== null && (!Number.isFinite(targetKb) || targetKb <= 0 || targetKb > Number.MAX_SAFE_INTEGER / 1024)) {
            showOperationMessage("Enter a valid maximum file size greater than 0 KB.", "error");
            elements.compressionTarget.focus();
            return;
        }
        elements.batchDownloadButton.disabled = true;
        try {
            const zip = new window.JSZip();
            const usedNames = new Map();
            let exported = 0;
            for (let index = 0; index < state.outputs.length; index += 1) {
                const output = state.outputs[index];
                try {
                    const converted = await createDownloadOutput(output, format, targetKb);
                    const dot = converted.name.lastIndexOf(".");
                    const stem = dot > 0 ? converted.name.slice(0, dot) : converted.name;
                    const extension = dot > 0 ? converted.name.slice(dot) : "";
                    const count = usedNames.get(converted.name) || 0;
                    usedNames.set(converted.name, count + 1);
                    const uniqueName = count ? `${stem} (${count + 1})${extension}` : converted.name;
                    zip.file(uniqueName, converted.blob);
                    updateBatchFileStatus(output.sourceIndex, `Ready · ${formatBytes(converted.blob.size)}`);
                    exported += 1;
                } catch (error) {
                    console.error(`Could not export ${output.name}:`, error);
                    updateBatchFileStatus(output.sourceIndex, "Export failed", true);
                }
                updateProgress(`Preparing ${index + 1}/${state.outputs.length} for ZIP`, index + 1, state.outputs.length);
                await nextPaint();
            }
            if (!exported) throw new Error(`No photos could be exported as ${format.toUpperCase()} with the selected size limit.`);
            const archive = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(archive);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "geotagged-photos.zip";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            const skipped = state.files.length - exported;
            const sizeNote = targetKb === null ? "" : `, maximum ${formatBytes(targetKb * 1024)} each`;
            showOperationMessage(`Downloaded ${exported} geotagged ${format.toUpperCase()} ${exported === 1 ? "photo" : "photos"}${sizeNote} as a ZIP archive${skipped ? `; ${skipped} could not be exported` : ""}.`, skipped ? "error" : "success");
        } catch (error) {
            console.error("ZIP generation failed:", error);
            showOperationMessage("The ZIP archive could not be created. Try downloading the batch again.", "error");
        } finally {
            elements.batchDownloadButton.disabled = false;
        }
    }

    async function createTargetSizeImage(image, format, targetBytes, exifTiff) {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const mimeType = format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
        let width = image.naturalWidth;
        let height = image.naturalHeight;

        for (let resizeAttempt = 0; resizeAttempt < 32; resizeAttempt += 1) {
            canvas.width = width;
            canvas.height = height;
            context.drawImage(image, 0, 0, width, height);

            let bestBlob = null;
            let largestUnderTarget = 0.05;
            let smallestOverTarget = 0.95;
            const minimumQualityBlob = await encodeAndAttach(0.05);
            if (minimumQualityBlob.size <= targetBytes) {
                bestBlob = minimumQualityBlob;
                if (format !== "png") {
                    for (let qualityAttempt = 0; qualityAttempt < 9; qualityAttempt += 1) {
                        const quality = (largestUnderTarget + smallestOverTarget) / 2;
                        const candidate = await encodeAndAttach(quality);
                        if (candidate.size <= targetBytes) {
                            bestBlob = candidate;
                            largestUnderTarget = quality;
                        } else {
                            smallestOverTarget = quality;
                        }
                    }
                }
                return bestBlob;
            }

            if (width === 1 && height === 1) break;
            const scale = Math.min(0.85, Math.sqrt(targetBytes / minimumQualityBlob.size) * 0.9);
            const nextWidth = Math.max(1, Math.floor(width * scale));
            const nextHeight = Math.max(1, Math.floor(height * scale));
            width = nextWidth === width && width > 1 ? width - 1 : nextWidth;
            height = nextHeight === height && height > 1 ? height - 1 : nextHeight;
        }

        throw new Error("This image cannot fit within that size limit, even at the smallest usable dimensions.");

        async function encodeAndAttach(quality) {
            const encodedBlob = await canvasToBlob(canvas, mimeType, format === "png" ? undefined : quality);
            return attachExif(encodedBlob, format, exifTiff, width, height);
        }
    }

    function canvasToBlob(canvas, mimeType, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob || blob.type !== mimeType) {
                    reject(new Error(`Your browser could not export this image as ${mimeType.replace("image/", "").toUpperCase()}.`));
                    return;
                }
                resolve(blob);
            }, mimeType, quality);
        });
    }

    function attachExif(blob, format, exifTiff, width, height) {
        if (format === "jpeg") return addJpegExif(blob, exifTiff);
        if (format === "png") return addPngExif(blob, exifTiff);
        return addWebpExif(blob, exifTiff, width, height);
    }

    async function addJpegExif(blob, exifTiff) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("The compressed JPEG export is invalid.");
        const exifPrefix = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]);
        const payloadLength = exifPrefix.length + exifTiff.length;
        if (payloadLength > 65533) throw new Error("The photo metadata is too large to fit in a JPEG file.");
        const segment = new Uint8Array(payloadLength + 4);
        segment[0] = 0xff;
        segment[1] = 0xe1;
        new DataView(segment.buffer).setUint16(2, payloadLength + 2);
        segment.set(exifPrefix, 4);
        segment.set(exifTiff, 10);
        return new Blob([bytes.subarray(0, 2), segment, bytes.subarray(2)], { type: "image/jpeg" });
    }

    async function extractExifTiff(jpegBlob) {
        const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("The tagged JPEG could not be read.");
        for (let offset = 2; offset + 4 <= bytes.length;) {
            if (bytes[offset] !== 0xff) break;
            const marker = bytes[offset + 1];
            if (marker === 0xda || marker === 0xd9) break;
            const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
            const payloadStart = offset + 4;
            const payloadEnd = offset + 2 + segmentLength;
            if (payloadEnd > bytes.length) break;
            if (marker === 0xe1 && bytes[payloadStart] === 0x45 && bytes[payloadStart + 1] === 0x78 && bytes[payloadStart + 2] === 0x69 && bytes[payloadStart + 3] === 0x66 && bytes[payloadStart + 4] === 0 && bytes[payloadStart + 5] === 0) {
                return bytes.slice(payloadStart + 6, payloadEnd);
            }
            offset = payloadEnd;
        }
        throw new Error("The verified JPEG does not contain an EXIF GPS block.");
    }

    async function verifyWebpMetadata(blob, expected) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        for (let offset = 12; offset + 8 <= bytes.length;) {
            const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
            const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
            const payloadStart = offset + 8;
            const payloadEnd = payloadStart + length;
            if (payloadEnd > bytes.length) return false;
            if (type === "EXIF") {
                const hasExifPrefix = length >= 6 && bytes[payloadStart] === 0x45 && bytes[payloadStart + 1] === 0x78 && bytes[payloadStart + 2] === 0x69 && bytes[payloadStart + 3] === 0x66 && bytes[payloadStart + 4] === 0 && bytes[payloadStart + 5] === 0;
                const tiff = bytes.slice(payloadStart + (hasExifPrefix ? 6 : 0), payloadEnd);
                if (!(tiff[0] === 0x49 && tiff[1] === 0x49 && tiff[2] === 0x2a && tiff[3] === 0)
                    && !(tiff[0] === 0x4d && tiff[1] === 0x4d && tiff[2] === 0 && tiff[3] === 0x2a)) return false;
                const metadata = await window.exifr.parse(new Blob([tiff], { type: "image/tiff" }), { tiff: true, exif: true, gps: true });
                const gps = metadata && { latitude: metadata.latitude, longitude: metadata.longitude };
                const tolerance = 5e-10;
                return Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)
                    && Math.abs(gps.latitude - expected.latitude) <= tolerance
                    && Math.abs(gps.longitude - expected.longitude) <= tolerance;
            }
            offset = payloadStart + length + (length & 1);
        }
        return false;
    }

    async function addPngExif(blob, exifTiff) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("The PNG export is invalid.");
        let insertionOffset = 8;
        while (insertionOffset + 12 <= bytes.length) {
            const length = new DataView(bytes.buffer, bytes.byteOffset + insertionOffset, 4).getUint32(0);
            const type = String.fromCharCode(...bytes.subarray(insertionOffset + 4, insertionOffset + 8));
            if (type === "IDAT") break;
            insertionOffset += 12 + length;
        }
        if (insertionOffset > bytes.length) throw new Error("The PNG export has an invalid chunk layout.");
        const exifChunk = makePngChunk("eXIf", exifTiff);
        return new Blob([bytes.subarray(0, insertionOffset), exifChunk, bytes.subarray(insertionOffset)], { type: "image/png" });
    }

    function makePngChunk(type, data) {
        const typeBytes = new TextEncoder().encode(type);
        const chunk = new Uint8Array(12 + data.length);
        const view = new DataView(chunk.buffer);
        view.setUint32(0, data.length);
        chunk.set(typeBytes, 4);
        chunk.set(data, 8);
        view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
        return chunk;
    }

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    async function addWebpExif(blob, exifTiff, width, height) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") {
            throw new Error("The WebP export is invalid.");
        }
        const chunks = [];
        let hasExtendedHeader = false;
        let extendedHeader = null;
        let hasAlpha = false;
        for (let offset = 12; offset + 8 <= bytes.length;) {
            const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
            const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
            const end = offset + 8 + length + (length & 1);
            if (end > bytes.length) throw new Error("The WebP export has an invalid chunk layout.");
            if (type === "VP8X") {
                hasExtendedHeader = true;
                extendedHeader = bytes.slice(offset, end);
                chunks.push(extendedHeader);
            } else if (type !== "EXIF") {
                if (type === "ALPH" || (type === "VP8L" && (bytes[offset + 12] & 0x10))) hasAlpha = true;
                chunks.push(bytes.slice(offset, end));
            }
            offset = end;
        }
        if (extendedHeader) extendedHeader[8] |= 0x08 | (hasAlpha ? 0x10 : 0);
        if (!hasExtendedHeader) {
            const header = new Uint8Array(18);
            header.set(new TextEncoder().encode("VP8X"), 0);
            new DataView(header.buffer).setUint32(4, 10, true);
            header[8] = 0x08 | (hasAlpha ? 0x10 : 0);
            writeUint24(header, 12, width - 1);
            writeUint24(header, 15, height - 1);
            chunks.unshift(header);
        }
        chunks.push(makeWebpChunk("EXIF", exifTiff));
        const body = concatBytes(...chunks);
        const output = new Uint8Array(12 + body.length);
        output.set(bytes.subarray(0, 12));
        new DataView(output.buffer).setUint32(4, output.length - 8, true);
        output.set(body, 12);
        return new Blob([output], { type: "image/webp" });
    }

    function writeUint24(bytes, offset, value) {
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >>> 8) & 0xff;
        bytes[offset + 2] = (value >>> 16) & 0xff;
    }

    function makeWebpChunk(type, data) {
        const chunk = new Uint8Array(8 + data.length + (data.length & 1));
        chunk.set(new TextEncoder().encode(type), 0);
        new DataView(chunk.buffer).setUint32(4, data.length, true);
        chunk.set(data, 8);
        return chunk;
    }

    function concatBytes(...parts) {
        const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            output.set(part, offset);
            offset += part.length;
        }
        return output;
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("The geotagged image could not be opened for conversion."));
            image.src = url;
        });
    }

    async function convertImageToJpegDataUrl(url) {
        const image = await loadImage(url);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Your browser could not prepare this image for GPS metadata.");
        context.drawImage(image, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.92);
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
        state.files = [];
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
        elements.batchFileList.replaceChildren();
        elements.batchFileList.hidden = true;
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