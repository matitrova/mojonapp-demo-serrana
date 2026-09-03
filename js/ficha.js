// ---------------------------------------------------------------------------
// Ficha del lote: el panel que se abre al tocar un lote (en el mapa, en la
// grilla, desde el dashboard o por deep-link) — datos, fotos (Cloudinary),
// interesados (mini-CRM), editores inline de servicios/zona/barrio, borrar
// lote, "Cómo llegar" y "Compartir este lote".
//
// Es el módulo más llamado por el resto de la app (por eso quedó para el
// final de la modularización) — pero nada de lo que necesita de otros
// módulos pasa por una dependencia circular real: mapa.js/vista-lista.js/
// dashboard.js reciben mostrarFicha() (y algunas otras funciones de acá)
// por parámetro (configurarX()), no por `import`, así que este archivo
// puede importar esos tres directo sin crear un ciclo.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import {
  doc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { centroideDePoligono, textoMedidasLados } from "./geometria.js";
import {
  getLoteSeleccionado,
  setLoteSeleccionado,
  setLoteEditadoDesdeFicha,
  getDeepLinkAbierto,
  setDeepLinkAbierto,
  getLotesActuales
} from "./estado.js";
import { puedeEditarLote, puedeBorrarLote } from "./permisos.js";
import { poblarSelectSector, poblarSelectBarrio } from "./catalogos.js";
import { mapa, cargarLotesDesdeFirestore, abrirTooltipDeLote } from "./mapa.js";
import { mostrarEditarLoteDesdeGrilla } from "./vista-lista.js";
import { registrarVistaDeLote } from "./dashboard.js";
import { registrarAuditoria } from "./auditoria.js";

const COLECCION_LOTES = "lotes";

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

// Texto de estado listo para mostrar, con la fecha de vencimiento de la
// reserva si corresponde ("Reservado (hasta 15/09/2026)" o "Reservado
// (vencida desde 10/09/2026)" en rojo) — para que un lote reservado
// hace rato y nunca actualizado no pase desapercibido. HTML porque el
// "vencida" va en rojo (.texto-vencido); si no hay fecha, se devuelve
// como texto plano (sin riesgo: ETIQUETA_ESTADO no trae HTML).
function textoEstadoConVencimiento(p) {
  const base = ETIQUETA_ESTADO[p.estado] || p.estado;
  if (p.estado !== "reservado" || !p.reservado_hasta) return base;
  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = new Date(`${p.reservado_hasta}T00:00:00`).toLocaleDateString("es-AR");
  return p.reservado_hasta < hoy
    ? `${base} <span class="texto-vencido">(vencida desde ${fecha})</span>`
    : `${base} (hasta ${fecha})`;
}

// Servicios que puede tener un lote (luz/agua/gas/cloaca). El catastro no
// trae este dato — solo se carga a mano, así que la mayoría de los lotes
// importados de "+ Manzana"/"+ Parcela" no van a tener el campo
// `servicios` en absoluto. Se distingue "sin dato" (no se muestra nada)
// de "no tiene el servicio" (chip apagado).
const SERVICIOS_INFO = [
  { clave: "luz", icono: "⚡", etiqueta: "Luz" },
  { clave: "agua", icono: "🚰", etiqueta: "Agua" },
  { clave: "gas", icono: "🔥", etiqueta: "Gas" },
  { clave: "cloaca", icono: "🚽", etiqueta: "Cloaca" }
];

function renderServiciosHTML(servicios) {
  if (servicios == null) return "Sin datos";
  return SERVICIOS_INFO.map(({ clave, icono, etiqueta }) => {
    const tiene = !!servicios[clave];
    return `<span class="chip-servicio${tiene ? "" : " sin-servicio"}">${icono} ${etiqueta}</span>`;
  }).join("");
}

// Mismo helper que usa el resto de la app para las hojas inferiores
// (ficha, login, formularios de carga): cerrar las demás al abrir una.
// Se duplica acá (5 líneas, sin estado propio) en vez de importarla de
// app.js — evita otra dependencia circular por algo tan chico.
function abrirHoja(elHoja) {
  document.querySelectorAll(".hoja-inferior").forEach((hoja) => {
    if (hoja !== elHoja) hoja.classList.add("oculto");
  });
  elHoja.classList.remove("oculto");
}

const elFicha = document.getElementById("ficha-lote");
const elTitulo = document.getElementById("ficha-titulo");
const elSuperficie = document.getElementById("ficha-superficie");
const elMedidas = document.getElementById("ficha-medidas");
const elEstado = document.getElementById("ficha-estado");
const elPrecio = document.getElementById("ficha-precio");
const elServicios = document.getElementById("ficha-servicios");
const elObservaciones = document.getElementById("ficha-observaciones");

// ---------------------------------------------------------------------------
// Fotos del lote: se suben directo desde el navegador a Cloudinary (plan
// gratis, sin tarjeta — a diferencia de Firebase Storage o Cloudflare R2,
// que piden tarjeta cargada aunque el uso se mantenga gratis, ver charla
// con el usuario) usando un "upload preset" sin firmar (unsigned) — el
// modo pensado por Cloudinary para subir directo desde el cliente sin
// exponer ninguna clave secreta ni necesitar un servidor propio. Firestore
// solo guarda la URL resultante (y el public_id, por si en el futuro hace
// falta) en un array "fotos" del lote, mismo patrón que "interesados"
// (arrayUnion/arrayRemove) más abajo.
//
// Cloud name y upload preset de la cuenta de Cloudinary del usuario —
// ninguno de los dos es secreto (a diferencia del API key/secret, que
// jamás deben viajar al navegador): son justamente los dos únicos datos
// que Cloudinary espera ver embebidos en código de cliente para el modo
// "unsigned". El preset está configurado como Unsigned + carpeta
// "mojonapp-lotes" en el panel de Cloudinary.
const CLOUDINARY_CLOUD_NAME = "ipuyvn4v";
const CLOUDINARY_UPLOAD_PRESET = "mojonapp_lotes";

const elFichaFotos = document.getElementById("ficha-fotos");
const elGaleriaFotos = document.getElementById("galeria-fotos-lote");
const elSubirFotoLabel = document.getElementById("subir-foto-label");
const elInputFotoLote = document.getElementById("input-foto-lote");
const elFichaFotoCargando = document.getElementById("ficha-foto-cargando");
const elFichaFotoError = document.getElementById("ficha-foto-error");

async function subirFotoACloudinary(archivo) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("Cloudinary todavía no está configurado en la app (falta CLOUDINARY_CLOUD_NAME/CLOUDINARY_UPLOAD_PRESET).");
  }
  const formData = new FormData();
  formData.append("file", archivo);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const respuesta = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData
  });
  if (!respuesta.ok) {
    throw new Error("Cloudinary rechazó la subida.");
  }
  const datos = await respuesta.json();
  // Un objeto chico y estable a propósito: arrayRemove (ver borrarFoto)
  // necesita coincidir EXACTO con lo que ya está guardado para poder
  // sacarlo, así que cuantos menos campos variables, mejor.
  return { url: datos.secure_url, id: datos.public_id };
}

function renderFotos(feature) {
  const fotos = feature.properties.fotos || [];
  const puedeSubir = puedeEditarLote(feature);

  elFichaFotos.classList.toggle("oculto", fotos.length === 0 && !puedeSubir);
  elSubirFotoLabel.classList.toggle("oculto", !puedeSubir);

  elGaleriaFotos.innerHTML = "";
  fotos.forEach((foto) => {
    const contenedor = document.createElement("div");
    contenedor.className = "foto-lote";

    const img = document.createElement("img");
    img.src = foto.url;
    img.loading = "lazy";
    img.alt = "Foto del lote";
    // Ver más grande en una pestaña aparte — más simple que armar un
    // visor propio para una sola imagen a la vez.
    img.addEventListener("click", () => window.open(foto.url, "_blank"));
    contenedor.appendChild(img);

    if (puedeSubir) {
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-foto";
      botonBorrar.textContent = "×";
      botonBorrar.setAttribute("aria-label", "Borrar foto");
      botonBorrar.addEventListener("click", (evento) => {
        evento.stopPropagation();
        borrarFoto(feature, foto);
      });
      contenedor.appendChild(botonBorrar);
    }

    elGaleriaFotos.appendChild(contenedor);
  });
}

async function borrarFoto(feature, foto) {
  if (!window.confirm("¿Borrar esta foto del lote?")) return;
  try {
    // Solo saca la referencia en Firestore — el archivo en sí sigue
    // ocupando espacio en Cloudinary. Borrarlo de ahí también necesita
    // una llamada FIRMADA (con la clave secreta), que no puede hacerse
    // con seguridad desde el navegador — queda fuera de alcance por
    // ahora, la cuota gratis (25GB) da para mucho antes de que importe.
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { fotos: arrayRemove(foto) });
    feature.properties.fotos = (feature.properties.fotos || []).filter((f) => f !== foto);
    renderFotos(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para borrar fotos de este lote." : "No se pudo borrar la foto."
    );
  }
}

elInputFotoLote.addEventListener("change", async () => {
  const archivo = elInputFotoLote.files[0];
  if (!archivo || !getLoteSeleccionado()) return;

  elFichaFotoError.classList.add("oculto");
  elFichaFotoCargando.classList.remove("oculto");
  elInputFotoLote.disabled = true;
  try {
    const foto = await subirFotoACloudinary(archivo);
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { fotos: arrayUnion(foto) });
    if (!getLoteSeleccionado().properties.fotos) getLoteSeleccionado().properties.fotos = [];
    getLoteSeleccionado().properties.fotos.push(foto);
    renderFotos(getLoteSeleccionado());
  } catch (error) {
    elFichaFotoError.textContent =
      error.code === "permission-denied" ? "No tenés permiso para agregar fotos a este lote." : "No se pudo subir la foto. Probá de nuevo.";
    elFichaFotoError.classList.remove("oculto");
  } finally {
    elFichaFotoCargando.classList.add("oculto");
    elInputFotoLote.disabled = false;
    elInputFotoLote.value = "";
  }
});

// Interesados: mini-CRM liviano, solo para quien puede editar el lote.
const elFichaInteresados = document.getElementById("ficha-interesados");
const elListaInteresados = document.getElementById("lista-interesados");
const formularioInteresado = document.getElementById("formulario-interesado");
const elInteresadoNombre = document.getElementById("interesado-nombre");
const elInteresadoTelefono = document.getElementById("interesado-telefono");
const elInteresadoNota = document.getElementById("interesado-nota");
const elInteresadoError = document.getElementById("interesado-error");

function renderInteresados(feature) {
  const interesados = feature.properties.interesados || [];
  elListaInteresados.innerHTML = "";
  interesados.forEach((interesado) => {
    const fila = document.createElement("li");
    fila.className = "fila-interesado";

    const datos = document.createElement("div");
    datos.className = "fila-interesado-datos";
    const fecha = interesado.fecha
      ? new Date(`${interesado.fecha}T00:00:00`).toLocaleDateString("es-AR")
      : "";
    datos.innerHTML = `<strong>${interesado.nombre}</strong>${
      interesado.telefono ? ` · ${interesado.telefono}` : ""
    }${interesado.nota ? ` · ${interesado.nota}` : ""}${fecha ? ` <span>(${fecha})</span>` : ""}`;

    const botonBorrar = document.createElement("button");
    botonBorrar.type = "button";
    botonBorrar.textContent = "Borrar";
    botonBorrar.addEventListener("click", () => borrarInteresado(feature, interesado));

    fila.append(datos, botonBorrar);
    elListaInteresados.appendChild(fila);
  });
}

async function borrarInteresado(feature, interesado) {
  if (!window.confirm(`¿Borrar a "${interesado.nombre}" de los interesados en este lote?`)) return;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { interesados: arrayRemove(interesado) });
    feature.properties.interesados = (feature.properties.interesados || []).filter((i) => i !== interesado);
    renderInteresados(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar interesados."
        : "No se pudo borrar."
    );
  }
}

formularioInteresado.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!getLoteSeleccionado()) return;
  elInteresadoError.classList.add("oculto");

  const nombre = elInteresadoNombre.value.trim();
  if (!nombre) return;
  const interesado = {
    nombre,
    telefono: elInteresadoTelefono.value.trim() || null,
    nota: elInteresadoNota.value.trim() || null,
    fecha: new Date().toISOString().slice(0, 10)
  };

  const boton = document.getElementById("interesado-guardar-btn");
  boton.disabled = true;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), {
      interesados: arrayUnion(interesado)
    });
    if (!getLoteSeleccionado().properties.interesados) {
      getLoteSeleccionado().properties.interesados = [];
    }
    getLoteSeleccionado().properties.interesados.push(interesado);
    renderInteresados(getLoteSeleccionado());
    formularioInteresado.reset();
  } catch (error) {
    elInteresadoError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para agregar interesados."
        : "No se pudo guardar.";
    elInteresadoError.classList.remove("oculto");
  } finally {
    boton.disabled = false;
  }
});

const elBtnEditarServicios = document.getElementById("btn-editar-servicios");
const elEditorServicios = document.getElementById("editor-servicios");
const elEditarServicioLuz = document.getElementById("editar-servicio-luz");
const elEditarServicioAgua = document.getElementById("editar-servicio-agua");
const elEditarServicioGas = document.getElementById("editar-servicio-gas");
const elEditarServicioCloaca = document.getElementById("editar-servicio-cloaca");
const elBtnGuardarServicios = document.getElementById("btn-guardar-servicios");
const elBtnCancelarServicios = document.getElementById("btn-cancelar-servicios");
const elEditorServiciosError = document.getElementById("editor-servicios-error");

const elSector = document.getElementById("ficha-sector");
const elBtnEditarSector = document.getElementById("btn-editar-sector");
const elEditorSector = document.getElementById("editor-sector");
const elEditarSectorValor = document.getElementById("editar-sector-valor");
const elBtnGuardarSector = document.getElementById("btn-guardar-sector");
const elBtnCancelarSector = document.getElementById("btn-cancelar-sector");
const elEditorSectorError = document.getElementById("editor-sector-error");

const elBarrio = document.getElementById("ficha-barrio");
const elBtnEditarBarrio = document.getElementById("btn-editar-barrio");
const elEditorBarrio = document.getElementById("editor-barrio");
const elEditarBarrioValor = document.getElementById("editar-barrio-valor");
const elBtnGuardarBarrio = document.getElementById("btn-guardar-barrio");
const elBtnCancelarBarrio = document.getElementById("btn-cancelar-barrio");
const elEditorBarrioError = document.getElementById("editor-barrio-error");

// Varios lotes reales todavía no tienen nomenclatura catastral asignada ni
// manzana/lote definidos (loteos nuevos, en trámite). Se arma el título con
// el mejor identificador disponible, sin mostrar nunca "null".
export function tituloLote(p) {
  if (p.nomenclatura) return p.nomenclatura;
  if (p.manzana != null && p.lote != null) return `Manzana ${p.manzana} — Lote ${p.lote}`;
  return "Lote sin nomenclatura catastral";
}

// Contenido del cartel que aparece al pasar el mouse por encima de un
// lote cargado (ver bindTooltip en mapa.js) — un resumen rápido sin
// tener que tocarlo y abrir la ficha completa.
export function contenidoTooltipLote(feature) {
  const p = feature.properties;
  const superficie = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  const precio = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  return `
    <div class="tooltip-lote-titulo">${tituloLote(p)}</div>
    <div>Zona: ${p.sector || "Sin datos"}</div>
    <div>Barrio: ${p.barrio || "Sin datos"}</div>
    <div>Superficie: ${superficie}</div>
    <div>Medidas: ${textoMedidasLados(feature.geometry.coordinates[0])}</div>
    <div>Estado: ${textoEstadoConVencimiento(p)}</div>
    <div>Precio: ${precio}</div>
  `;
}

export function mostrarFicha(feature) {
  setLoteSeleccionado(feature);
  const p = feature.properties;

  elTitulo.textContent = tituloLote(p);
  elSector.textContent = p.sector || "Sin datos";
  elBarrio.textContent = p.barrio || "Sin datos";
  // superficie_m2 puede venir en null: el catastro no siempre la declara
  // para sub-parcelas (se vio con datos reales de "+ Manzana"), y a
  // diferencia del formulario manual, la importación en bloque no pasa
  // por el "required" del campo — puede llegar null a Firestore.
  elSuperficie.textContent = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  elMedidas.textContent = textoMedidasLados(feature.geometry.coordinates[0]);
  elEstado.innerHTML = textoEstadoConVencimiento(p);
  elPrecio.textContent = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  elServicios.innerHTML = renderServiciosHTML(p.servicios);
  elObservaciones.textContent = p.observaciones || "Sin datos";
  renderFotos(feature);

  document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(feature));
  document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(feature));
  document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(feature));
  elFichaInteresados.classList.toggle("oculto", !puedeEditarLote(feature));
  renderInteresados(feature);
  cerrarEditorServicios(); // por si había quedado abierto en el lote anterior
  cerrarEditorSector();
  cerrarEditorBarrio();

  abrirHoja(elFicha);
  registrarVistaDeLote(feature);
}

document.getElementById("cerrar-ficha").addEventListener("click", () => {
  elFicha.classList.add("oculto");
});

// "Editar lote" en la ficha abre el mismo formulario completo que
// "Editar" desde la grilla (manzana/lote/nomenclatura/superficie/
// estado/precio/sector/servicios/observaciones) — pedido explícito:
// antes solo se podía corregir todo eso yendo a "Ver como lista", acá
// arriba del mapa solo había editores sueltos para sector y servicios.
// Reusa mostrarEditarLoteDesdeGrilla tal cual para no duplicar la
// validación de nomenclatura ni el guardado.
document.getElementById("btn-editar-lote-completo").addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  elFicha.classList.add("oculto");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("vista-lista").classList.remove("oculto");
  document.getElementById("btn-ver-lista").classList.add("activo");
  setLoteEditadoDesdeFicha(true);
  mostrarEditarLoteDesdeGrilla(getLoteSeleccionado());
});

// Editar servicios de un lote ya cargado: el catastro no trae este dato,
// así que la mayoría de los lotes traídos por "+ Manzana"/"+ Parcela"
// necesitan que un corredor lo complete después, no solo al cargarlos a
// mano. Mismo criterio de permiso que "Borrar lote" (propio/ajeno, ver
// puedeEditarLote).
export function cerrarEditorServicios() {
  elEditorServicios.classList.add("oculto");
  elServicios.classList.remove("oculto");
  elBtnEditarServicios.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorServiciosError.classList.add("oculto");
}

elBtnEditarServicios.addEventListener("click", () => {
  const servicios = getLoteSeleccionado()?.properties?.servicios || {};
  elEditarServicioLuz.checked = !!servicios.luz;
  elEditarServicioAgua.checked = !!servicios.agua;
  elEditarServicioGas.checked = !!servicios.gas;
  elEditarServicioCloaca.checked = !!servicios.cloaca;
  elServicios.classList.add("oculto");
  elBtnEditarServicios.classList.add("oculto");
  elEditorServicios.classList.remove("oculto");
});

elBtnCancelarServicios.addEventListener("click", cerrarEditorServicios);

elBtnGuardarServicios.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const servicios = {
    luz: elEditarServicioLuz.checked,
    agua: elEditarServicioAgua.checked,
    gas: elEditarServicioGas.checked,
    cloaca: elEditarServicioCloaca.checked
  };

  elBtnGuardarServicios.disabled = true;
  elEditorServiciosError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { servicios });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: "Editó servicios"
    });
    getLoteSeleccionado().properties.servicios = servicios;
    elServicios.innerHTML = renderServiciosHTML(servicios);
    cerrarEditorServicios();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorServiciosError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar servicios. Iniciá sesión de nuevo."
        : "No se pudieron guardar los servicios.";
    elEditorServiciosError.classList.remove("oculto");
  } finally {
    elBtnGuardarServicios.disabled = false;
  }
});

// Editar sector/zona: es el corredor quien organiza su propia cartera
// (el catastro no tiene idea de "sectores"), así que casi todo lote
// importado necesita que alguien se lo asigne después. Mismo criterio
// de permiso y mismo patrón que "Editar servicios".
export function cerrarEditorSector() {
  elEditorSector.classList.add("oculto");
  elSector.classList.remove("oculto");
  elBtnEditarSector.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorSectorError.classList.add("oculto");
}

elBtnEditarSector.addEventListener("click", () => {
  poblarSelectSector(elEditarSectorValor, getLoteSeleccionado()?.properties?.sector);
  elSector.classList.add("oculto");
  elBtnEditarSector.classList.add("oculto");
  elEditorSector.classList.remove("oculto");
  elEditarSectorValor.focus();
});

elBtnCancelarSector.addEventListener("click", cerrarEditorSector);

elBtnGuardarSector.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const sector = elEditarSectorValor.value.trim() || null;

  elBtnGuardarSector.disabled = true;
  elEditorSectorError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { sector });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: `Zona: ${getLoteSeleccionado().properties.sector || "Sin datos"} → ${sector || "Sin datos"}`
    });
    getLoteSeleccionado().properties.sector = sector;
    elSector.textContent = sector || "Sin datos";
    cerrarEditorSector();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorSectorError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar la zona. Iniciá sesión de nuevo."
        : "No se pudo guardar la zona.";
    elEditorSectorError.classList.remove("oculto");
  } finally {
    elBtnGuardarSector.disabled = false;
  }
});

// Editar barrio: mismo patrón exacto que "Editar zona" arriba — segunda
// categorización independiente de un lote.
export function cerrarEditorBarrio() {
  elEditorBarrio.classList.add("oculto");
  elBarrio.classList.remove("oculto");
  elBtnEditarBarrio.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorBarrioError.classList.add("oculto");
}

elBtnEditarBarrio.addEventListener("click", () => {
  poblarSelectBarrio(elEditarBarrioValor, getLoteSeleccionado()?.properties?.barrio);
  elBarrio.classList.add("oculto");
  elBtnEditarBarrio.classList.add("oculto");
  elEditorBarrio.classList.remove("oculto");
  elEditarBarrioValor.focus();
});

elBtnCancelarBarrio.addEventListener("click", cerrarEditorBarrio);

elBtnGuardarBarrio.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const barrio = elEditarBarrioValor.value.trim() || null;

  elBtnGuardarBarrio.disabled = true;
  elEditorBarrioError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { barrio });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: `Barrio: ${getLoteSeleccionado().properties.barrio || "Sin datos"} → ${barrio || "Sin datos"}`
    });
    getLoteSeleccionado().properties.barrio = barrio;
    elBarrio.textContent = barrio || "Sin datos";
    cerrarEditorBarrio();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorBarrioError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar el barrio. Iniciá sesión de nuevo."
        : "No se pudo guardar el barrio.";
    elEditorBarrioError.classList.remove("oculto");
  } finally {
    elBtnGuardarBarrio.disabled = false;
  }
});

// "Borrar lote": solo visible para quien puede editar/borrar ese lote
// puntual (ver puedeBorrarLote). Pide confirmación porque borrar un
// documento de Firestore no se puede deshacer. La usan tanto el botón
// de la ficha como el de cada fila de la vista en lista.
export async function borrarLote(feature, elBoton) {
  const titulo = tituloLote(feature.properties);
  if (!window.confirm(`¿Borrar "${titulo}"? No se puede deshacer.`)) return;

  if (elBoton) elBoton.disabled = true;
  try {
    await deleteDoc(doc(db, COLECCION_LOTES, feature.id));
    registrarAuditoria({ accion: "borrar_lote", objetoId: feature.id, objetoTitulo: titulo });
    elFicha.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar lotes. Iniciá sesión de nuevo."
        : "No se pudo borrar el lote."
    );
  } finally {
    if (elBoton) elBoton.disabled = false;
  }
}

const elBtnBorrarLote = document.getElementById("btn-borrar-lote");
elBtnBorrarLote.addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  borrarLote(getLoteSeleccionado(), elBtnBorrarLote);
});

// ---------------------------------------------------------------------------
// Botón "Cómo llegar": abre Google Maps marcando el centroide del lote.
// Se usa el endpoint de búsqueda (maps/search, no maps/dir): probado a mano,
// "dir" (navegación) puede resolver la coordenada al comercio indexado más
// cercano y mostrar ESE nombre como destino (p. ej. un lote vacío terminó
// etiquetado como un taller de chapa y pintura a varios metros de ahí).
// "search" en cambio deja el pin exactamente en la coordenada que mandamos,
// sin sustituirlo por otro lugar. No admite una etiqueta con el nombre del
// lote (se probó el viejo truco de "lat,lon(Texto)" y ya no funciona, Google
// Maps directamente no encuentra la ubicación) — muestra coordenadas o el
// Plus Code, no el texto del lote. Tampoco calcula una ruta: es responsabilidad
// del corredor iniciar la navegación una vez que confirma visualmente el pin.
// ---------------------------------------------------------------------------

function construirUrlComoLlegar(feature) {
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

document.getElementById("btn-como-llegar").addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  const url = construirUrlComoLlegar(getLoteSeleccionado());
  window.open(url, "_blank", "noopener");
});

// "Compartir este lote": arma un link a esta misma app con "?lote=<id>"
// (ver abrirLoteDesdeUrlSiCorresponde en app.js) — mandado por WhatsApp a
// un cliente, abre la app directo en la ficha de ESE lote, sin que tenga
// que buscarlo a mano en el mapa. En el celular usa el selector nativo
// para compartir (WhatsApp, etc.) si está disponible; si no, copia el
// link al portapapeles.
const elCompartirLoteMensaje = document.getElementById("compartir-lote-mensaje");

document.getElementById("btn-compartir-lote").addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const url = `${location.origin}${location.pathname}?lote=${getLoteSeleccionado().id}`;
  const titulo = tituloLote(getLoteSeleccionado().properties);

  if (navigator.share) {
    try {
      await navigator.share({ title: `MojonApp - ${titulo}`, url });
    } catch {
      // El usuario canceló el selector de compartir, o el navegador lo
      // bloqueó — no es un error real, no hace falta avisar nada.
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    elCompartirLoteMensaje.textContent = "Link copiado.";
    elCompartirLoteMensaje.classList.remove("oculto");
    setTimeout(() => elCompartirLoteMensaje.classList.add("oculto"), 2500);
  } catch {
    // Sin permiso de portapapeles (o sin soportarlo, como algunos
    // navegadores embebidos): se deja el link a la vista, seleccionable
    // a mano, en vez de depender de prompt() — no todos los entornos lo
    // soportan (ver quirk de testing en la memoria del proyecto).
    elCompartirLoteMensaje.textContent = url;
    elCompartirLoteMensaje.classList.remove("oculto");
  }
});

// Si la app se abrió con "?lote=<id>" (link armado por "Compartir este
// lote"), abre esa ficha directo apenas hay datos para buscarla — una
// sola vez, no cada vez que cambia la sesión (login/logout también
// disparan cargarLotesDesdeFirestore en app.js, que llama a esto de
// nuevo, y no hay que reabrir el deep link en medio de que alguien esté
// usando la app).
export function abrirLoteDesdeUrlSiCorresponde() {
  if (getDeepLinkAbierto()) return;
  setDeepLinkAbierto(true);
  const idDesdeUrl = new URLSearchParams(location.search).get("lote");
  if (!idDesdeUrl) return;
  const feature = getLotesActuales().find((f) => f.id === idDesdeUrl);
  if (!feature) return;
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);

  // En "modo embed" (insertado en la web de una inmobiliaria, ver
  // index.html) la ficha completa (hoja inferior, hasta 70% del alto) tapa
  // casi toda la vista en un iframe chico — reportado en vivo: "no me
  // aparece en el mapa, solo me despliega el panel de info". Ahí alcanza
  // con centrar el mapa en el lote y abrir su cartel (mismo que aparece al
  // pasar el mouse), sin abrir el panel — el caso de uso real es "mostrame
  // dónde está este lote", no necesariamente todos sus datos.
  if (document.documentElement.classList.contains("modo-embed")) {
    abrirTooltipDeLote(feature.id);
    return;
  }

  mostrarFicha(feature);
}
