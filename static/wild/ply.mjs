// Minimal PLY reader for the prediction bundles the runners publish:
// binary little-endian, float x/y/z vertices, optional red/green/blue vertex
// colours (uchar 0..255 or float 0..1; returned as `colors` in 0..1, else null;
// other vertex properties are skipped) and an optional face list (triangulated
// by fan). Point clouds have no face element and come back with `indices: null`.

const SCALAR_BYTES = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function readScalar(view, offset, type) {
  switch (type) {
    case "char": case "int8": return view.getInt8(offset);
    case "uchar": case "uint8": return view.getUint8(offset);
    case "short": case "int16": return view.getInt16(offset, true);
    case "ushort": case "uint16": return view.getUint16(offset, true);
    case "int": case "int32": return view.getInt32(offset, true);
    case "uint": case "uint32": return view.getUint32(offset, true);
    case "float": case "float32": return view.getFloat32(offset, true);
    case "double": case "float64": return view.getFloat64(offset, true);
    default: throw new Error(`unsupported PLY scalar type: ${type}`);
  }
}

function parseHeader(bytes) {
  const marker = new TextEncoder().encode("end_header\n");
  let end = -1;
  for (let i = 0; i + marker.length <= bytes.length && i < 65536; i += 1) {
    let hit = true;
    for (let j = 0; j < marker.length; j += 1) {
      if (bytes[i + j] !== marker[j]) { hit = false; break; }
    }
    if (hit) { end = i + marker.length; break; }
  }
  if (end < 0) throw new Error("PLY header has no end_header");
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n").map((l) => l.trim());
  if (lines[0] !== "ply") throw new Error("not a PLY file");
  if (!lines.includes("format binary_little_endian 1.0")) {
    throw new Error("only binary_little_endian PLY is supported");
  }
  const elements = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      elements.push({ name: parts[1], count: Number(parts[2]), properties: [] });
    } else if (parts[0] === "property" && elements.length) {
      const element = elements[elements.length - 1];
      if (parts[1] === "list") {
        element.properties.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
      } else {
        element.properties.push({ list: false, type: parts[1], name: parts[2] });
      }
    }
  }
  return { elements, bodyOffset: end };
}

export function parsePly(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { elements, bodyOffset } = parseHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = bodyOffset;
  let positions = new Float32Array(0);
  let colors = null;
  let indices = null;
  let vertexCount = 0;
  let faceCount = 0;

  for (const element of elements) {
    if (element.name === "vertex") {
      const axes = { x: -1, y: -1, z: -1 };
      const channels = { red: -1, green: -1, blue: -1 };
      element.properties.forEach((property, index) => {
        if (property.list) throw new Error("list-typed vertex properties are not supported");
        if (property.name in axes) axes[property.name] = index;
        if (property.name in channels) channels[property.name] = index;
      });
      if (axes.x < 0 || axes.y < 0 || axes.z < 0) throw new Error("PLY vertices lack x/y/z");
      const hasColor = channels.red >= 0 && channels.green >= 0 && channels.blue >= 0;
      vertexCount = element.count;
      positions = new Float32Array(vertexCount * 3);
      if (hasColor) colors = new Float32Array(vertexCount * 3);
      for (let v = 0; v < vertexCount; v += 1) {
        element.properties.forEach((property, index) => {
          const value = readScalar(view, offset, property.type);
          offset += SCALAR_BYTES[property.type];
          if (index === axes.x) positions[v * 3] = value;
          else if (index === axes.y) positions[v * 3 + 1] = value;
          else if (index === axes.z) positions[v * 3 + 2] = value;
          else if (hasColor && (index === channels.red || index === channels.green || index === channels.blue)) {
            const slot = index === channels.red ? 0 : index === channels.green ? 1 : 2;
            const isByte = property.type === "uchar" || property.type === "uint8";
            colors[v * 3 + slot] = isByte ? value / 255 : value;
          }
        });
      }
    } else if (element.name === "face") {
      const triangles = [];
      for (let f = 0; f < element.count; f += 1) {
        for (const property of element.properties) {
          if (!property.list) {
            offset += SCALAR_BYTES[property.type];
            continue;
          }
          const count = readScalar(view, offset, property.countType);
          offset += SCALAR_BYTES[property.countType];
          const corners = [];
          for (let c = 0; c < count; c += 1) {
            corners.push(readScalar(view, offset, property.itemType));
            offset += SCALAR_BYTES[property.itemType];
          }
          if (/vertex_ind/.test(property.name)) {
            for (let c = 1; c + 1 < corners.length; c += 1) {
              triangles.push(corners[0], corners[c], corners[c + 1]);
            }
          }
        }
      }
      faceCount = element.count;
      indices = new Uint32Array(triangles);
    } else {
      // Skip unknown fixed-size elements; list-typed ones cannot be skipped blindly.
      for (let e = 0; e < element.count; e += 1) {
        for (const property of element.properties) {
          if (property.list) {
            const count = readScalar(view, offset, property.countType);
            offset += SCALAR_BYTES[property.countType] + count * SCALAR_BYTES[property.itemType];
          } else {
            offset += SCALAR_BYTES[property.type];
          }
        }
      }
    }
  }
  return { positions, colors, indices, vertexCount, faceCount };
}
