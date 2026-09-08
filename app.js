"use strict";

(async function () {
  const status = document.getElementById("status");
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"})[char]);

  try {
    const [runtime, manifest, planningStyle] = await Promise.all([
      fetch("config/runtime-config.json", {cache: "no-store"}).then(response => response.ok ? response.json() : Promise.reject(new Error("runtime-config.json could not be loaded"))),
      fetch("config/map-manifest.json", {cache: "no-store"}).then(response => response.ok ? response.json() : Promise.reject(new Error("map-manifest.json could not be loaded"))),
      fetch("config/map-style.json", {cache: "no-store"}).then(response => response.ok ? response.json() : Promise.reject(new Error("map-style.json could not be loaded"))),
    ]);

    const protocol = new pmtiles.Protocol({metadata: true});
    maplibregl.addProtocol("pmtiles", protocol.tile);
    const nodes = new Map(manifest.nodes.map(node => [node.id, node]));
    const leaves = manifest.nodes.filter(node => node.web_included && node.is_feature_layer);
    const readSession = (key, fallback) => {
      try {
        const value = window.sessionStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
      } catch (_error) {
        return fallback;
      }
    };
    const writeSession = (key, value) => {
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch (_error) { /* optional state */ }
    };
    const defaultsRevision = String(runtime.defaults_revision ?? 1);
    const useConfiguredDefaults = String(readSession("districtPlans.defaultsRevision", "")) !== defaultsRevision;
    const savedVisibility = useConfiguredDefaults ? {} : readSession("districtPlans.visibility", {});
    const defaultVisibleGroups = new Set(runtime.default_visible_groups || []);
    const isVisibleByDefault = node => defaultVisibleGroups.size
      ? (node.group_path || []).some(group => defaultVisibleGroups.has(group))
      : Boolean(node.effective_visible);
    const leafVisibility = new Map(leaves.map(node => [
      node.id,
      Object.prototype.hasOwnProperty.call(savedVisibility, node.id)
        ? Boolean(savedVisibility[node.id])
        : isVisibleByDefault(node),
    ]));
    let opacityFactor = Number(useConfiguredDefaults
      ? runtime.default_planning_opacity
      : readSession("districtPlans.opacity", runtime.default_planning_opacity));
    if (!Number.isFinite(opacityFactor) || opacityFactor < 0 || opacityFactor > 1) opacityFactor = 1;
    const savedBasemapId = useConfiguredDefaults
      ? runtime.default_basemap
      : readSession("districtPlans.basemap", runtime.default_basemap);
    const initialBasemapId = runtime.basemaps.some(item => item.id === savedBasemapId)
      ? savedBasemapId
      : runtime.default_basemap;
    const savedView = useConfiguredDefaults ? null : readSession("districtPlans.view", null);

    const blankStyle = {
      version: 8,
      name: "No basemap",
      sources: {},
      layers: [{id: "page-background", type: "background", paint: {"background-color": "#eef1f3"}}],
    };
    const basemapSelect = document.getElementById("basemap");
    for (const item of runtime.basemaps) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === initialBasemapId;
      basemapSelect.append(option);
    }
    const getBasemapStyle = id => {
      const item = runtime.basemaps.find(candidate => candidate.id === id);
      if (item?.style_url) return item.style_url;
      if (item?.raster_url) {
        return {
          version: 8,
          name: item.label,
          sources: {
            "basemap-raster": {
              type: "raster",
              tiles: [item.raster_url],
              tileSize: item.tile_size || 256,
              minzoom: item.minzoom ?? 0,
              maxzoom: item.maxzoom ?? 22,
              attribution: item.attribution || "",
            },
          },
          layers: [
            {id: "page-background", type: "background", paint: {"background-color": "#eef1f3"}},
            {id: "basemap-raster", type: "raster", source: "basemap-raster"},
          ],
        };
      }
      return blankStyle;
    };
    writeSession("districtPlans.defaultsRevision", defaultsRevision);
    const mapOptions = {
      container: "map",
      style: getBasemapStyle(initialBasemapId),
      attributionControl: true,
    };
    if (savedView?.center && Number.isFinite(savedView.zoom)) {
      Object.assign(mapOptions, {
        center: savedView.center,
        zoom: savedView.zoom,
        bearing: savedView.bearing || 0,
        pitch: savedView.pitch || 0,
      });
    } else {
      Object.assign(mapOptions, {bounds: manifest.map.wgs84_bounds, fitBoundsOptions: {padding: 30}});
    }
    const map = new maplibregl.Map(mapOptions);
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({unit: "metric"}), "bottom-right");

    function applyLeafVisibility(node) {
      const visibility = leafVisibility.get(node.id) ? "visible" : "none";
      for (const layerId of node.style_layer_ids || []) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }

    function applyOpacity() {
      for (const layer of planningStyle.layers) {
        if (!map.getLayer(layer.id)) continue;
        const property = {fill: "fill-opacity", line: "line-opacity", circle: "circle-opacity", symbol: "text-opacity"}[layer.type];
        if (property) {
          const original = layer.paint?.[property] ?? 1;
          if (typeof original === "number") map.setPaintProperty(layer.id, property, original * opacityFactor);
        }
        if (layer.type === "circle") {
          const originalStroke = layer.paint?.["circle-stroke-opacity"] ?? 1;
          if (typeof originalStroke === "number") map.setPaintProperty(layer.id, "circle-stroke-opacity", originalStroke * opacityFactor);
        }
      }
    }

    function installPlanningLayers() {
      try {
        const configuredArchives = new Map((runtime.pmtiles_archives || [
          {source_id: "planning", url: runtime.pmtiles_url},
        ]).map(item => [item.source_id, item]));
        for (const [sourceId, sourceDefinition] of Object.entries(planningStyle.sources || {})) {
          if (map.getSource(sourceId)) continue;
          const source = {...sourceDefinition};
          const configuredUrl = configuredArchives.get(sourceId)?.url;
          const styleUrl = String(source.url || "").replace(/^pmtiles:\/\//, "");
          source.url = "pmtiles://" + new URL(configuredUrl || styleUrl, window.location.href).href;
          map.addSource(sourceId, source);
        }
        for (const layer of planningStyle.layers) {
          if (!map.getLayer(layer.id)) map.addLayer(structuredClone(layer));
        }
        leaves.forEach(applyLeafVisibility);
        applyOpacity();
        setStatus(`${leaves.length} planning layers loaded.`);
        window.setTimeout(() => { if (!status.classList.contains("error")) setStatus(""); }, 2500);
      } catch (error) {
        console.error(error);
        setStatus(`Planning layers could not be installed: ${error.message}`, true);
      }
    }
    map.on("style.load", installPlanningLayers);
    map.on("load", installPlanningLayers);
    function installPlanningLayersWhenReady(attempt = 0) {
      if (map.isStyleLoaded()) {
        installPlanningLayers();
      } else if (attempt < 100) {
        window.setTimeout(() => installPlanningLayersWhenReady(attempt + 1), 100);
      } else {
        setStatus("Planning layers could not be installed because the basemap style did not finish loading.", true);
      }
    }
    installPlanningLayersWhenReady();
    basemapSelect.addEventListener("change", () => {
      setStatus("Changing basemap…");
      writeSession("districtPlans.basemap", basemapSelect.value);
      writeSession("districtPlans.view", {
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
      writeSession("districtPlans.visibility", Object.fromEntries(leafVisibility));
      writeSession("districtPlans.opacity", opacityFactor);
      // Initial style loading is reliable across third-party providers, while
      // swapping unrelated style documents in-place can strand custom PMTiles
      // layers. A session-preserving reload avoids that MapLibre lifecycle edge.
      window.location.reload();
    });

    const descendantLeaves = node => node.is_feature_layer
      ? (node.web_included ? [node] : [])
      : (node.children || []).flatMap(id => nodes.has(id) ? descendantLeaves(nodes.get(id)) : []);

    const checkboxById = new Map();
    function refreshCheckboxes() {
      for (const [id, checkbox] of checkboxById) {
        const node = nodes.get(id);
        const childLeaves = descendantLeaves(node);
        const selected = childLeaves.filter(leaf => leafVisibility.get(leaf.id)).length;
        checkbox.checked = childLeaves.length > 0 && selected === childLeaves.length;
        checkbox.indeterminate = selected > 0 && selected < childLeaves.length;
      }
    }

    function setNodeVisibility(node, visible) {
      for (const leaf of descendantLeaves(node)) {
        leafVisibility.set(leaf.id, visible);
        applyLeafVisibility(leaf);
      }
      refreshCheckboxes();
      renderLegend();
      writeSession("districtPlans.visibility", Object.fromEntries(leafVisibility));
    }

    function checkboxFor(node) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `Toggle ${node.display_name}`);
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => setNodeVisibility(node, checkbox.checked));
      checkboxById.set(node.id, checkbox);
      return checkbox;
    }

    function buildTreeNode(node, depth = 0) {
      if (!node.web_included) return null;
      if (node.is_group) {
        const details = document.createElement("details");
        details.open = depth < 2;
        const summary = document.createElement("summary");
        const checkbox = checkboxFor(node);
        const label = document.createElement("span");
        label.textContent = node.display_name;
        summary.append(checkbox, label);
        details.append(summary);
        for (const childId of node.children || []) {
          const child = nodes.get(childId);
          if (child) {
            const element = buildTreeNode(child, depth + 1);
            if (element) details.append(element);
          }
        }
        return details;
      }
      const row = document.createElement("div");
      row.className = "leaf";
      const checkbox = checkboxFor(node);
      const label = document.createElement("label");
      label.textContent = node.display_name;
      label.addEventListener("click", () => { checkbox.checked = !checkbox.checked; setNodeVisibility(node, checkbox.checked); });
      row.append(checkbox, label);
      return row;
    }

    const tree = document.getElementById("layer-tree");
    for (const id of manifest.root_ids) {
      const node = nodes.get(id);
      if (node) {
        const element = buildTreeNode(node);
        if (element) tree.append(element);
      }
    }

    function renderLegend() {
      const legend = document.getElementById("legend");
      legend.replaceChildren();
      for (const node of leaves.filter(item => leafVisibility.get(item.id))) {
        const details = document.createElement("details");
        details.className = "legend-layer";
        const summary = document.createElement("summary");
        summary.textContent = node.display_name;
        details.append(summary);
        for (const item of node.legend || []) {
          const row = document.createElement("div");
          row.className = "legend-item";
          const swatch = document.createElement("span");
          swatch.className = "swatch " + (item.geometry_type === "Polyline" ? "line" : ["Point", "Multipoint"].includes(item.geometry_type) ? "point" : "polygon");
          swatch.style.background = item.color;
          swatch.style.borderColor = item.outline_color || item.color;
          const text = document.createElement("span");
          text.textContent = item.label;
          row.append(swatch, text);
          details.append(row);
        }
        legend.append(details);
      }
      if (!legend.children.length) legend.textContent = "No visible planning layers.";
    }
    refreshCheckboxes();
    renderLegend();

    const opacityControl = document.getElementById("opacity");
    opacityControl.value = String(Math.round(opacityFactor * 100));
    document.getElementById("opacity-value").value = `${opacityControl.value}%`;
    opacityControl.addEventListener("input", event => {
      opacityFactor = Number(event.target.value) / 100;
      document.getElementById("opacity-value").value = `${event.target.value}%`;
      applyOpacity();
      writeSession("districtPlans.opacity", opacityFactor);
    });
    document.getElementById("sidebar-toggle").addEventListener("click", event => {
      const sidebar = document.getElementById("sidebar");
      sidebar.classList.toggle("closed");
      event.currentTarget.setAttribute("aria-expanded", String(!sidebar.classList.contains("closed")));
      window.setTimeout(() => map.resize(), 220);
    });

    map.on("click", event => {
      const visibleIds = leaves.flatMap(node => leafVisibility.get(node.id) ? (node.style_layer_ids || []) : []).filter(id => map.getLayer(id));
      if (!visibleIds.length) return;
      const feature = map.queryRenderedFeatures(event.point, {layers: visibleIds})[0];
      if (!feature) return;
      const logicalId = map.getLayer(feature.layer.id)?.metadata?.logicalLayerId;
      const node = nodes.get(logicalId);
      if (!node) return;
      const rows = (node.popup?.fields || []).map(field => {
        const value = feature.properties?.[field.name];
        if (value === null || value === undefined || value === "") return "";
        const rendered = /^https?:\/\//i.test(String(value))
          ? `<a href="${escapeHtml(value)}" target="_blank" rel="noopener">${escapeHtml(value)}</a>`
          : escapeHtml(value);
        return `<tr><th>${escapeHtml(field.alias)}</th><td>${rendered}</td></tr>`;
      }).join("");
      new maplibregl.Popup().setLngLat(event.lngLat).setHTML(`<h3>${escapeHtml(node.display_name)}</h3><table class="popup-grid">${rows || "<tr><td>No attributes available.</td></tr>"}</table>`).addTo(map);
    });
    map.on("mousemove", event => {
      const visibleIds = leaves.flatMap(node => leafVisibility.get(node.id) ? (node.style_layer_ids || []) : []).filter(id => map.getLayer(id));
      map.getCanvas().style.cursor = visibleIds.length && map.queryRenderedFeatures(event.point, {layers: visibleIds}).length ? "pointer" : "";
    });
    map.on("error", event => {
      const message = event.error?.message || "Unknown map error";
      if (/pmtiles|source|tile/i.test(message)) setStatus(`Planning archive could not be read: ${message}`, true);
    });
  } catch (error) {
    console.error(error);
    setStatus(`Map initialization failed: ${error.message}`, true);
  }
})();
