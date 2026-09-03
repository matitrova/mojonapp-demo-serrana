// ---------------------------------------------------------------------------
// Mapa base (Leaflet + capa satelital Esri), la capa de lotes cargados
// (leerlos de Firestore y dibujarlos) y "Ver catastro cercano" — viven
// juntos en este módulo porque cargarLotesDesdeFirestore() necesita
// conocer el estado de "catastro cercano" (lo saca del mapa un instante
// mientras redibuja, para no trabar el navegador con las dos capas
// reconstruyéndose a la vez).
//
// `mostrarFicha`/`contenidoTooltipLote` todavía viven en app.js (Ficha no
// es un módulo separado en este punto de la modularización) — se
// inyectan por parámetro vía configurarMapa() para evitar una
// dependencia circular. `mapa`, `cargarLotesDesdeFirestore` y
// `anilloAGeometryFirestore` sí se exportan: son la base que necesita
// prácticamente cualquier otro módulo de la app.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { centroideDePoligono } from "./geometria.js";
import {
  CATASTRO_WFS_URL,
  CATASTRO_CBA_WFS_URL,
  CATASTRO_BSAS_WFS_URL,
  pedirWfsA,
  esParcelaDeCalle,
  normalizarParcelaSanLuis,
  normalizarParcelaCordoba,
  normalizarParcelaBuenosAires,
  primerAnilloDeGeometria
} from "./catastro-normalizacion.js";
import { getMiPerfil, setLotesActuales, getModoCaptura, onSesionCerrada } from "./estado.js";
import { esRootActual, tienePermiso } from "./permisos.js";
import { actualizarVistaLista } from "./vista-lista.js";
import { bboxDelMapaVisible, cargarParcelaEnFormLote } from "./cargar-lote.js";

const COLECCION_LOTES = "lotes";

const COLOR_POR_ESTADO = {
  disponible: "#2e7d32",
  reservado: "#f9a825",
  vendido: "#c62828"
};

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

let mostrarFicha, contenidoTooltipLote;

// app.js llama esto una sola vez, antes de tocar un lote en el mapa.
export function configurarMapa(deps) {
  ({ mostrarFicha, contenidoTooltipLote } = deps);
}

// ---------------------------------------------------------------------------
// Mapa base
// ---------------------------------------------------------------------------

// maxZoom (24) es hasta dónde deja acercarse el mapa; maxNativeZoom es
// hasta dónde Esri realmente tiene fotos en la zona rural que usa esta
// app (en el centro de una ciudad grande puede llegar a 20-21, pero en
// el campo suele cortar antes). Sin maxNativeZoom, pasado ese punto
// Leaflet pide tiles que no existen y el mapa queda en blanco ("Map
// data not yet available"). Con maxNativeZoom, Leaflet sigue
// permitiendo acercarse: agranda el último tile real en vez de pedir
// uno inexistente, así que la imagen se ve más borrosa pero el mapa
// nunca desaparece — y el polígono del lote, que es un dibujo
// vectorial y no una imagen, se sigue viendo nítido en cualquier zoom.
//
// El valor 18 se verificó bajando tiles reales del servicio para
// Carpintería/Merlo (zona de los lotes cargados): en zoom 18 la imagen
// es satelital real (~13-18 KB por tile); en zoom 19 y más, Esri
// devuelve siempre el mismo tile de "Map data not yet available"
// (2521 bytes exactos) — el corte real acá es 18, no 19. Si el corredor
// carga lotes en otra zona con mejor cobertura, en el peor caso el mapa
// se ve un poco más borroso ahí de lo estrictamente necesario, pero
// nunca desaparece — eso es preferible a que desaparezca en ESTA zona.
export const mapa = L.map("mapa", { zoomControl: true, maxZoom: 24 }).setView([-32.34715, -65.01300], 18);

// Capa satelital gratuita (Esri World Imagery, sin API key).
// Si más adelante contratan un proveedor con mejor resolución (Mapbox, Google Maps
// Platform, etc.), la capa se cambia acá: reemplazar la URL y el "attribution".
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 24,
    maxNativeZoom: 18,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
  }
).addTo(mapa);

// Capas de referencia (calles, localidades, límites) — mismo proveedor
// gratis y sin API key que la imagen satelital, pensadas por Esri
// justo para superponerse arriba de "World_Imagery" (fondo
// transparente, solo texto/líneas). Pedido explícito: la vista
// satelital sola no trae ningún nombre. Ninguna de las dos muestra un
// placeholder feo fuera de su zoom nativo — donde no tienen nada que
// dibujar, el tile viene vacío/transparente nomás (verificado bajando
// tiles reales).
//
// Son DOS capas, no una — se probó primero solo con
// "World_Boundaries_and_Places" y quedó vacía justo en el zoom 16-18
// que usa la app para mirar lotes (esa capa solo tiene nombres de
// localidad/límites a zoom bajo, ≤15 en la zona de Merlo/Carpintería —
// confirmado bajando tiles reales, deja de traer nada más cerca).
// "World_Transportation" es la que sí tiene calles con nombre en ese
// rango de zoom (confirmado con un tile real: "Avenida del Sol",
// "Presbítero Becerra", "C Champaquí" cerca de los lotes cargados) —
// juntas cubren tanto "en qué localidad estoy" (zoom lejos) como "qué
// calle es esta" (zoom cerca), que es lo que se pidió.
// minZoom 16: con todo el pueblo a la vista (zoom ~14-15) esta capa
// mete el nombre de CADA calle, y se ve como un empapelado de texto
// encima del satelital — reportado en vivo ("muchas cosas en
// pantalla"). Recién se prende al acercarse a la escala de un barrio,
// que es donde realmente hace falta saber qué calle es cuál.
// opacity 0.75: la tipografía de Esri para estas capas viene con halo
// blanco bien marcado — no hay forma de aflojar el grosor de la letra
// en sí (son tiles ya dibujados en el servidor, no texto editable del
// lado del navegador), pero bajarle la opacidad a la capa entera
// atenúa ese contraste tan fuerte contra el satelital sin perder
// legibilidad — pedido en vivo ("no quiero que se vean tan
// resaltadas").
const capasReferencia = L.layerGroup([
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 24,
    maxNativeZoom: 23, // tope real del servicio, confirmado por su propio ?f=json
    minZoom: 16,
    opacity: 0.75,
    attribution: "Reference &copy; Esri"
  }),
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 24,
    maxNativeZoom: 23,
    minZoom: 16,
    opacity: 0.75,
    attribution: "Reference &copy; Esri"
  })
]).addTo(mapa);

// Leyenda de colores por estado
const leyenda = L.control({ position: "bottomleft" });
leyenda.onAdd = function () {
  const div = L.DomUtil.create("div", "leyenda-estados");
  div.innerHTML = Object.keys(COLOR_POR_ESTADO)
    .map(
      (estado) =>
        `<div><span style="background:${COLOR_POR_ESTADO[estado]}"></span>${ETIQUETA_ESTADO[estado]}</div>`
    )
    .join("");
  return div;
};
leyenda.addTo(mapa);

let capaLotes = null;
const elMensajeCargaInicial = document.getElementById("mensaje-carga-inicial");

// Un documento de Firestore es {geometry, ...propiedades} (ver
// formularioLote.addEventListener("submit", ...) en cargar-lote.js). Se
// reconstruye como Feature GeoJSON para reusar el resto del código
// (ficha, centroide, "estoy yendo"), que ya trabaja con esa forma.
//
// geometry.coordinates en Firestore NO es el anillo GeoJSON de siempre
// ([[lon,lat], ...]): Firestore no permite un array que tenga otro array
// como elemento directo (a cualquier profundidad), y coordinates de un
// Polygon GeoJSON son array de array de [lon,lat] — tres niveles. Se
// guarda como un array plano de objetos {lon, lat} (los lotes de esta app
// nunca tienen agujeros, así que un solo anillo alcanza) y se lo envuelve
// de vuelta en el formato GeoJSON estándar acá, solo en memoria.
// La conversión inversa: un anillo GeoJSON ([lon, lat], ...) al formato
// plano que sí acepta Firestore. La usan tanto la carga manual (vértices
// pegados a mano) como la importación de manzanas del catastro.
export function anilloAGeometryFirestore(anillo) {
  return {
    type: "Polygon",
    coordinates: anillo.map(([lon, lat]) => ({ lon, lat }))
  };
}

// Abre el cartel (tooltip) de un lote puntual sin tocar la ficha — lo usa
// "modo embed" (ver ficha.js) para marcar cuál es el lote elegido sobre
// el mapa sin abrir el panel completo, que en un iframe chico tapa casi
// toda la vista.
export function abrirTooltipDeLote(loteId) {
  if (!capaLotes) return;
  capaLotes.eachLayer((capa) => {
    if (capa.feature?.id === loteId) capa.openTooltip();
  });
}

function docALoteFeature(doc) {
  const { geometry, ...properties } = doc.data();
  const anillo = geometry.coordinates.map((punto) => [punto.lon, punto.lat]);
  return {
    type: "Feature",
    id: doc.id,
    properties,
    geometry: { type: "Polygon", coordinates: [anillo] }
  };
}

// Se muestra un "Cargando lotes…" solo la primera vez que arranca la
// app — esta función se vuelve a llamar seguido después (al guardar un
// lote, al iniciar/cerrar sesión, etc.) y repetir el aviso en cada una
// de esas veces sería más ruido que ayuda, además de parpadear sobre
// lotes que ya están a la vista.
let primeraCargaDeLotesHecha = false;

export async function cargarLotesDesdeFirestore() {
  if (!primeraCargaDeLotesHecha) elMensajeCargaInicial.classList.remove("oculto");

  // Un corredor sin "ver_todos_los_lotes" solo trae lo suyo — root, y
  // cualquiera sin sesión (el catálogo público), siguen viendo todo.
  const restringirAPropios = !!getMiPerfil() && !esRootActual() && !tienePermiso("ver_todos_los_lotes");
  const consulta = restringirAPropios
    ? query(collection(db, COLECCION_LOTES), where("creado_por", "==", auth.currentUser.uid))
    : collection(db, COLECCION_LOTES);
  const snapshot = await getDocs(consulta);
  const features = snapshot.docs.map(docALoteFeature);
  setLotesActuales(features); // la vista en grilla reusa esto, no vuelve a pedirle nada a Firestore
  actualizarVistaLista();

  // Reconstruir capaLotes con "Ver catastro cercano" prendido (600+
  // elementos ya en el DOM) es lo que causaba el freeze real que se vio
  // con "+ Manzana" al importar varios lotes de golpe — se saca la capa
  // de referencia un momento y se repone después de terminar, sin
  // volver a pedirle nada al catastro.
  const habiaCatastroCercano = capaCatastroCercano && mapa.hasLayer(capaCatastroCercano);
  if (habiaCatastroCercano) mapa.removeLayer(capaCatastroCercano);

  if (capaLotes) {
    mapa.removeLayer(capaLotes);
  }

  capaLotes = L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: (feature) => ({
        color: "#ffffff",
        weight: 2,
        fillColor: COLOR_POR_ESTADO[feature.properties.estado] || "#888",
        fillOpacity: 0.55,
        // Clase estable por lote (adelante del id va una letra siempre,
        // "lote-", porque un id de Firestore puede arrancar con un
        // número y eso no es válido como iniciador de clase CSS). La
        // usan los tests para apuntar a un lote puntual en vez de
        // contar todos los polígonos del mapa — necesario ahora que la
        // colección tiene lotes reales además de los que siembra cada
        // test.
        className: `lote-poligono lote-${feature.id}`
      }),
      onEachFeature: (feature, layer) => {
        layer.on("click", () => {
          // Si se está capturando vértices (a mano en el mapa, o con GPS),
          // tocar un lote ya cargado no debería abrir su ficha encima y
          // pisar lo que se venía marcando — se ignora el click acá y,
          // en el caso de "dibujar en el mapa", sigue de largo hasta el
          // listener del mapa para agregarlo como vértice.
          if (getModoCaptura() !== null) return;
          mostrarFicha(feature);
        });
        // Pasar el mouse por encima adelanta un resumen sin tener que
        // tocar el lote — pedido explícito. "sticky" para que el cartel
        // siga al cursor en vez de quedar fijo en un punto del
        // polígono (con lotes grandes, quedaba lejos del mouse).
        layer.bindTooltip(contenidoTooltipLote(feature), {
          direction: "top",
          sticky: true,
          className: "tooltip-lote-mapa"
        });
      }
    }
  ).addTo(mapa);

  if (features.length > 0) {
    // maxZoom explícito: si el contenedor del mapa todavía no tiene un
    // tamaño real en este instante (puede pasar, esta llamada es lo
    // primero que corre la app apenas responde Firestore), Leaflet
    // calcula mal el zoom que hace falta para encuadrar y termina
    // clavado en el maxZoom del mapa (24) — un solo lote de golpe
    // aislado en una esquina, imagen satelital reventada de borrosa.
    // Reproducido de forma consistente en pruebas. 18 alcanza de sobra
    // para encuadrar cualquier cartera real de lotes de un corredor.
    mapa.fitBounds(capaLotes.getBounds(), { padding: [20, 20], maxZoom: 18 });
  }

  if (habiaCatastroCercano) capaCatastroCercano.addTo(mapa);

  elMensajeCargaInicial.classList.add("oculto");
  primeraCargaDeLotesHecha = true;
}

// app.js dispara la primera carga real recién después de configurarMapa()
// (necesita mostrarFicha/contenidoTooltipLote ya inyectados) — ver
// iniciarMapa() más abajo. Se devuelve la promesa: app.js la encadena con
// abrirLoteDesdeUrlSiCorresponde() para reaplicar el centrado del deep
// link si ESTA carga (la que pinta rápido, sin esperar la sesión) termina
// después que la de onAuthStateChanged — ver el comentario en esa función.
export function iniciarMapa() {
  return cargarLotesDesdeFirestore().catch((error) => {
    console.error("No se pudieron cargar los lotes desde Firestore:", error);
    // Si la primera carga falla, no dejar el aviso de "Cargando…" pegado
    // para siempre — mejor un mensaje de error concreto que uno que
    // sugiere que todavía está en curso.
    elMensajeCargaInicial.textContent = "No se pudieron cargar los lotes. Recargá la página para reintentar.";
  });
}

// ---------------------------------------------------------------------------
// "Ver catastro cercano": en vez de escribir un número de manzana o
// parcela a ciegas, muestra las parcelas oficiales alrededor (con su
// número, como en el visor del catastro) para tocar directo la que se
// quiere cargar. Usa el mismo WFS que "+ Manzana" / "+ Parcela" — esos
// dos siguen sirviendo para importar varios lotes de una sin ir tocando
// el mapa uno por uno.
// ---------------------------------------------------------------------------

const elBtnVerCatastroCercano = document.getElementById("btn-ver-catastro-cercano");
const elCatastroCercanoMensaje = document.getElementById("catastro-cercano-mensaje");
const elBtnFlotanteCatastro = document.getElementById("btn-flotante-catastro");
const ZOOM_MINIMO_CATASTRO_CERCANO = 16; // por debajo de esto el WFS traería demasiadas parcelas

let capaCatastroCercano = null;
let catastroCercanoActivo = false;

function estiloParcelaCatastroCercano() {
  return { color: "#f9a825", weight: 2, dashArray: "4 3", fillOpacity: 0.05 };
}

function mostrarMensajeCatastroCercano(texto) {
  elCatastroCercanoMensaje.textContent = texto;
  elCatastroCercanoMensaje.classList.remove("oculto");
}

function ocultarMensajeCatastroCercano() {
  elCatastroCercanoMensaje.classList.add("oculto");
}

// Los tres catastros (San Luis, Córdoba, Buenos Aires) se piden en
// paralelo y se combinan — geográficamente casi nunca se superponen
// entre sí, así que el que no tiene cobertura en el área visible
// simplemente devuelve 0 parcelas, sin afectar a los otros. Si alguno
// falla (well, "throws"), no tiene que tirar abajo a los que sí
// respondieron — Promise.allSettled en vez de esperar que las tres
// promesas salgan bien.
// Tope de features por catastro: en un área densa (un pueblo entero
// visible a zoom bajo) el WFS puede devolver miles de parcelas — eso es
// lo que trababa el mapa ("quiere cargar todo y se laguea"). Con el
// zoom mínimo ya exigido (ZOOM_MINIMO_CATASTRO_CERCANO) esto rara vez
// se llega a usar, pero es un techo duro para el peor caso.
const MAX_PARCELAS_CATASTRO_CERCANO = 400;

async function pedirParcelasCatastroCercano() {
  const bbox = bboxDelMapaVisible();
  const [sanLuis, cordoba, buenosAires] = await Promise.allSettled([
    pedirWfsA(CATASTRO_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "SanLuis:GIS_PARCELAS_VV",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(GEOM,${bbox},'EPSG:4326')`
    }),
    pedirWfsA(CATASTRO_CBA_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "idecor:parcelas_graf",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(geom,${bbox},'EPSG:4326')`
    }),
    pedirWfsA(CATASTRO_BSAS_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "idera:Parcela",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(geom,${bbox},'EPSG:4326')`
    })
  ]);

  const features = [];
  if (sanLuis.status === "fulfilled") {
    features.push(
      ...sanLuis.value.filter((f) => !esParcelaDeCalle(f.properties.NOMBRE)).map(normalizarParcelaSanLuis)
    );
  }
  if (cordoba.status === "fulfilled") {
    features.push(...cordoba.value.map(normalizarParcelaCordoba));
  }
  if (buenosAires.status === "fulfilled") {
    features.push(...buenosAires.value.map(normalizarParcelaBuenosAires));
  }

  // Error real solo si LOS TRES fallaron (sin conexión, etc.) — si
  // alguno respondió, así sea con 0 parcelas (zona sin cobertura en
  // ese catastro puntual), no hace falta alarmar por eso.
  const huboErrorTotal =
    sanLuis.status === "rejected" && cordoba.status === "rejected" && buenosAires.status === "rejected";
  return { features, huboErrorTotal };
}

// Se incrementa en cada llamada a actualizarCatastroCercano() — si el
// usuario paneó de nuevo antes de que la respuesta anterior llegara
// (common paneando rápido), esa respuesta vieja ya no es la generación
// actual y se descarta en vez de dibujar una capa que no corresponde a
// dónde está parado el mapa ahora.
let generacionCatastroCercano = 0;

async function actualizarCatastroCercano() {
  if (!catastroCercanoActivo) return;

  if (mapa.getZoom() < ZOOM_MINIMO_CATASTRO_CERCANO) {
    generacionCatastroCercano++; // invalida cualquier pedido en curso de antes de alejar el zoom
    if (capaCatastroCercano) {
      mapa.removeLayer(capaCatastroCercano);
      capaCatastroCercano = null;
    }
    mostrarMensajeCatastroCercano("Acercate más en el mapa para ver las parcelas cercanas.");
    return;
  }

  const generacion = ++generacionCatastroCercano;

  // El pedido a los 3 catastros puede tardar unos segundos con
  // conexión rural — sin este aviso, el mapa se queda sin cambios
  // visibles y parece que el botón no hizo nada.
  mostrarMensajeCatastroCercano("Buscando parcelas cercanas…");
  const { features, huboErrorTotal } = await pedirParcelasCatastroCercano();

  // Llegó tarde: el mapa ya se movió de nuevo y hay un pedido más nuevo
  // en curso (o ya resuelto) — no pisarlo con esta respuesta vieja.
  if (generacion !== generacionCatastroCercano) return;

  if (huboErrorTotal) {
    // La capa de referencia es un complemento opcional: si el catastro no
    // responde, no tiene que interrumpir el resto de la app — pero sí hay
    // que avisar, porque si no parece que el botón no hace nada.
    mostrarMensajeCatastroCercano("No se pudo cargar el catastro cercano ahora. Probá de nuevo en un momento.");
    return;
  }

  ocultarMensajeCatastroCercano();

  if (features.length === 0) {
    mostrarMensajeCatastroCercano("El catastro no tiene parcelas cargadas en esta zona.");
  }

  if (capaCatastroCercano) mapa.removeLayer(capaCatastroCercano);

  // La etiqueta de cada parcela NO se ata directo al polígono: el
  // centrado automático de Leaflet para un polígono ("direction: center")
  // sufre la misma cancelación numérica que ya corregimos en
  // centroideDePoligono() — con lotes de forma irregular (no
  // rectangulares, como suelen ser los reales) el número puede terminar
  // desplazado hacia el lote vecino. En cambio, se ancla a un marcador
  // invisible puesto exactamente en nuestro propio centroide (preciso).
  capaCatastroCercano = L.layerGroup();

  L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: estiloParcelaCatastroCercano,
      onEachFeature: (feature, layer) => {
        layer.on("click", (evento) => {
          // Mismo cuidado que en la capa de lotes cargados: no pisar una
          // captura de vértices en curso (ver el comentario en
          // cargarLotesDesdeFirestore).
          if (getModoCaptura() !== null) return;
          L.DomEvent.stopPropagation(evento);
          cargarParcelaEnFormLote(feature);
        });
      }
    }
  ).addTo(capaCatastroCercano);

  features.forEach((feature) => {
    const anillo = primerAnilloDeGeometria(feature.geometry);
    if (!anillo || anillo.length < 3) return;
    const { lat, lon } = centroideDePoligono(anillo);
    L.marker([lat, lon], {
      icon: L.divIcon({ className: "", iconSize: [0, 0] }),
      interactive: false
    })
      .bindTooltip(feature.properties._mojon.etiqueta || "", {
        permanent: true,
        direction: "center",
        className: "etiqueta-parcela-catastro"
      })
      .addTo(capaCatastroCercano);
  });

  // No mostrarla todavía si hay un formulario abierto tapando el mapa
  // (ver sincronizarVisibilidadCatastroCercano más abajo, que la muestra
  // sola apenas se cierre).
  if (!algunaHojaAbierta()) {
    capaCatastroCercano.addTo(mapa);
  }
}

// Apagar la capa de referencia: se llama desde el botón del drawer (al
// destildarlo), desde el botón flotante sobre el mapa (mismo efecto,
// sin tener que volver a abrir el menú — pedido explícito, entrar al
// drawer cada vez que se quiere desactivar era un mal trago), y al
// cerrar sesión.
function desactivarCatastroCercano() {
  catastroCercanoActivo = false;
  elBtnVerCatastroCercano.classList.remove("activo");
  elBtnFlotanteCatastro.classList.add("oculto");
  ocultarMensajeCatastroCercano();
  if (capaCatastroCercano) {
    mapa.removeLayer(capaCatastroCercano);
    capaCatastroCercano = null;
  }
  // Vuelve la capa de calles/localidades — mientras el catastro de
  // referencia está activo se saca (ver el "if" de abajo) para no
  // amontonar texto de los dos a la vez sobre el mapa.
  if (!mapa.hasLayer(capasReferencia)) capasReferencia.addTo(mapa);
}

elBtnVerCatastroCercano.addEventListener("click", () => {
  catastroCercanoActivo = !catastroCercanoActivo;
  elBtnVerCatastroCercano.classList.toggle("activo", catastroCercanoActivo);
  if (catastroCercanoActivo) {
    elBtnFlotanteCatastro.classList.remove("oculto");
    mapa.removeLayer(capasReferencia);
    actualizarCatastroCercano();
  } else {
    desactivarCatastroCercano();
  }
});

elBtnFlotanteCatastro.addEventListener("click", desactivarCatastroCercano);

onSesionCerrada(desactivarCatastroCercano);

// Debounce: paneando/haciendo zoom rápido, "moveend" puede disparar
// varias veces seguidas — sin esto, cada una lanzaba su propio par de
// pedidos WFS (San Luis + Córdoba) en paralelo, y ahí es donde se
// sentía pesado ("se laguea"). Se espera a que el mapa quede quieto un
// momento antes de pedir de nuevo.
let timerCatastroCercano = null;

mapa.on("moveend", () => {
  if (!catastroCercanoActivo) return;
  clearTimeout(timerCatastroCercano);
  timerCatastroCercano = setTimeout(actualizarCatastroCercano, 400);
});

// ---------------------------------------------------------------------------
// "Ver catastro cercano" puede agregar varios cientos de elementos al mapa
// (un polígono + un marcador + una etiqueta por cada parcela visible). Con
// eso activo, abrir cualquier formulario encima obligaba al navegador a
// repintar todo junto — lento, sobre todo en un celular. Mientras haya
// algún formulario abierto no hace falta ver esa capa (la atención está en
// el formulario, no en el mapa), así que se saca del mapa temporalmente
// —sin volver a pedirle nada al catastro— y se repone sola al cerrar todo.
// Un único observador cubre todas las hojas sin tener que tocar cada
// lugar del código que las abre o las cierra.
// Ojo: no es "cualquier hoja abierta" — "+ Manzana" y "+ Parcela" se
// dejan afuera a propósito. Son buscadores: el corredor los usa
// mirando los números de "Ver catastro cercano" para saber qué
// escribir, así que ocultar la capa mientras están abiertos rompía
// justo el caso de uso que la trajo. Sí se sigue ocultando en la ficha
// y en "Cargar a mano", que es donde de verdad se redibuja el mapa.
function algunaHojaAbierta() {
  return [document.getElementById("ficha-lote"), document.getElementById("form-lote")].some(
    (el) => !el.classList.contains("oculto")
  );
}

function sincronizarVisibilidadCatastroCercano() {
  if (!catastroCercanoActivo || !capaCatastroCercano) return;
  const debeOcultarse = algunaHojaAbierta();
  const estaEnElMapa = mapa.hasLayer(capaCatastroCercano);
  if (debeOcultarse && estaEnElMapa) {
    mapa.removeLayer(capaCatastroCercano);
  } else if (!debeOcultarse && !estaEnElMapa) {
    capaCatastroCercano.addTo(mapa);
  }
}

const observadorHojas = new MutationObserver(sincronizarVisibilidadCatastroCercano);
document.querySelectorAll(".hoja-inferior, #ficha-lote").forEach((el) => {
  observadorHojas.observe(el, { attributes: true, attributeFilter: ["class"] });
});
