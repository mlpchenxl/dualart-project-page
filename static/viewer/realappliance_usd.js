import {
	DoubleSide,
	LinearSRGBColorSpace,
	Matrix4,
	NoColorSpace,
	Object3D,
	Quaternion,
	SRGBColorSpace,
	TextureLoader,
	Vector3,
} from 'three';

import { USDCParser } from './vendor/USDCParser.js';
import { USDComposer } from './vendor/USDComposer.js';

const DEG = Math.PI / 180;
const PRIM_SPEC = 6;
const FRAME_POSITION_EPS = 1e-4;
const FRAME_ANGLE_EPS = 1e-3;

function report( onProgress, phase, loaded = 0, total = 0 ) {

	if ( onProgress ) onProgress( { phase, loaded, total } );

}

async function fetchBuffer( url, onProgress, signal ) {

	const response = await fetch( url, { signal } );
	if ( ! response.ok ) throw new Error( `USD request failed: HTTP ${response.status} ${url}` );

	const total = Number( response.headers.get( 'content-length' ) ) || 0;
	if ( ! response.body ) {

		const buffer = await response.arrayBuffer();
		report( onProgress, 'download', buffer.byteLength, total || buffer.byteLength );
		return buffer;

	}

	const reader = response.body.getReader();
	const chunks = [];
	let loaded = 0;

	while ( true ) {

		const { done, value } = await reader.read();
		if ( done ) break;
		chunks.push( value );
		loaded += value.byteLength;
		report( onProgress, 'download', loaded, total );

	}

	const bytes = new Uint8Array( loaded );
	let offset = 0;
	for ( const chunk of chunks ) {

		bytes.set( chunk, offset );
		offset += chunk.byteLength;

	}

	return bytes.buffer;

}

function attribute( specs, primPath, name, fallback = undefined ) {

	const fields = specs[ `${primPath}.${name}` ]?.fields;
	if ( ! fields ) return fallback;
	if ( fields.default !== undefined ) return fields.default;
	if ( fields.targetPaths !== undefined ) return fields.targetPaths;
	return fallback;

}

function asArray( value, fallback ) {

	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) ) return Array.from( value );
	return fallback.slice();

}

function vector3( value, fallback = [ 0, 0, 0 ] ) {

	const v = asArray( value, fallback );
	return new Vector3( Number( v[ 0 ] ) || 0, Number( v[ 1 ] ) || 0, Number( v[ 2 ] ) || 0 );

}

// USDCParser emits USD quaternions in Three's native [x, y, z, w] order.
function quaternion( value ) {

	const q = asArray( value, [ 0, 0, 0, 1 ] );
	const result = new Quaternion(
		Number( q[ 0 ] ) || 0,
		Number( q[ 1 ] ) || 0,
		Number( q[ 2 ] ) || 0,
		Number.isFinite( Number( q[ 3 ] ) ) ? Number( q[ 3 ] ) : 1,
	);
	return result.lengthSq() > 0 ? result.normalize() : new Quaternion();

}

function target( specs, primPath, relationship ) {

	const value = attribute( specs, primPath, relationship, [] );
	return Array.isArray( value ) && value.length ? String( value[ 0 ] ) : null;

}

function basename( path ) {

	return path ? path.slice( path.lastIndexOf( '/' ) + 1 ) : null;

}

function assetUrl( assetBase, path ) {

	const clean = String( path || '' ).replace( /^@|@$/g, '' ).replace( /^\.\//, '' );
	if ( /^(?:data:|blob:|https?:\/\/|\/)/.test( clean ) ) return clean;

	const base = assetBase ? ( assetBase.endsWith( '/' ) ? assetBase : `${assetBase}/` ) : './';
	if ( typeof document !== 'undefined' ) return new URL( clean, new URL( base, document.baseURI ) ).href;
	return `${base}${clean}`;

}

function tagUsdPaths( parent, parentPath, objectsByPath ) {

	for ( const child of parent.children ) {

		const path = parentPath === '/' ? `/${child.name}` : `${parentPath}/${child.name}`;
		child.userData.usdPath = path;
		objectsByPath.set( path, child );
		tagUsdPaths( child, path, objectsByPath );

	}

}

function shaderForMaterial( specs, materialPath ) {

	// 一个材质下往往挂着多个 Shader（表面 + 若干贴图读取器）。表面着色器才是
	// 要找的那个：优先按 info:id / MDL sourceAsset 认，认不出再退回第一个。
	const prefix = `${materialPath}/`;
	let first = null;
	for ( const [ path, spec ] of Object.entries( specs ) ) {

		if ( ! path.startsWith( prefix ) || spec.specType !== PRIM_SPEC || spec.fields.typeName !== 'Shader' ) continue;
		if ( first === null ) first = path;
		const id = String( attribute( specs, path, 'info:id', '' ) );
		if ( id === 'UsdPreviewSurface' || attribute( specs, path, 'info:mdl:sourceAsset', '' ) ) return path;

	}

	return first;

}

function connectedShader( specs, primPath, name ) {

	const fields = specs[ `${primPath}.${name}` ]?.fields;
	const paths = fields?.connectionPaths ?? fields?.targetPaths;
	if ( ! Array.isArray( paths ) || ! paths.length ) return null;
	// 连接目标形如 /Looks/M/tex.outputs:rgb —— 去掉属性名留下 shader 路径。
	const path = String( paths[ 0 ] );
	const dot = path.lastIndexOf( '.' );
	return dot > 0 ? path.slice( 0, dot ) : path;

}

function shaderTexture( specs, texturePath, textureLoader, textureSet, assetBase, warn, meshPath, colorSpace ) {

	const file = attribute( specs, texturePath, 'inputs:file', '' );
	if ( ! file || typeof Image === 'undefined' ) return null;
	const url = assetUrl( assetBase, String( file ) );
	const texture = textureLoader.load( url, undefined, undefined, () => {

		warn( 'texture_load_failed', `Texture failed to load: ${url}`, { usdPath: meshPath, url } );

	} );
	if ( colorSpace ) texture.colorSpace = colorSpace;
	textureSet.add( texture );
	return texture;

}

// UsdPreviewSurface：USD 的标准着色模型（glTF 血统的资产都走它）。数值输入是
// 线性的，贴图输入通过 connectionPaths 指向同材质下的 UsdUVTexture。
function configureUsdPreviewSurface( material, specs, shaderPath, textureLoader, textureSet, assetBase, warn, meshPath ) {

	const diffusePath = connectedShader( specs, shaderPath, 'inputs:diffuseColor' );
	const diffuseTexture = diffusePath
		? shaderTexture( specs, diffusePath, textureLoader, textureSet, assetBase, warn, meshPath, SRGBColorSpace )
		: null;
	if ( diffuseTexture ) {

		material.map = diffuseTexture;
		material.color.setRGB( 1, 1, 1, SRGBColorSpace );

	} else {

		const diffuse = asArray( attribute( specs, shaderPath, 'inputs:diffuseColor', [ 0.18, 0.18, 0.18 ] ), [ 0.18, 0.18, 0.18 ] );
		material.color.setRGB(
			Number( diffuse[ 0 ] ) || 0,
			Number( diffuse[ 1 ] ) || 0,
			Number( diffuse[ 2 ] ) || 0,
			LinearSRGBColorSpace,
		);

	}

	// metallic/roughness 常被同一张 ORM 贴图驱动（glTF 约定：B=金属度、G=粗糙度），
	// three 的 metalnessMap/roughnessMap 正好读同样的通道。
	for ( const [ input, mapName, scalarName, fallback ] of [
		[ 'inputs:metallic', 'metalnessMap', 'metalness', 0 ],
		[ 'inputs:roughness', 'roughnessMap', 'roughness', 0.5 ],
	] ) {

		const path = connectedShader( specs, shaderPath, input );
		const texture = path
			? shaderTexture( specs, path, textureLoader, textureSet, assetBase, warn, meshPath, null )
			: null;
		if ( texture ) {

			material[ mapName ] = texture;
			material[ scalarName ] = 1;

		} else {

			material[ scalarName ] = clamp01( attribute( specs, shaderPath, input, fallback ), fallback );

		}

	}

	boostMetalEnvironment( material );

	const normalPath = connectedShader( specs, shaderPath, 'inputs:normal' );
	const normalTexture = normalPath
		? shaderTexture( specs, normalPath, textureLoader, textureSet, assetBase, warn, meshPath, null )
		: null;
	if ( normalTexture ) material.normalMap = normalTexture;

	const emissive = asArray( attribute( specs, shaderPath, 'inputs:emissiveColor', [ 0, 0, 0 ] ), [ 0, 0, 0 ] );
	material.emissive.setRGB(
		Number( emissive[ 0 ] ) || 0,
		Number( emissive[ 1 ] ) || 0,
		Number( emissive[ 2 ] ) || 0,
		LinearSRGBColorSpace,
	);

	const opacity = clamp01( attribute( specs, shaderPath, 'inputs:opacity', 1 ), 1 );
	material.opacity = opacity;
	material.transparent = opacity < 1;
	material.depthWrite = ! material.transparent;

	if ( 'clearcoat' in material ) {

		material.clearcoat = clamp01( attribute( specs, shaderPath, 'inputs:clearcoat', 0 ), 0 );
		material.clearcoatRoughness = clamp01( attribute( specs, shaderPath, 'inputs:clearcoatRoughness', 0 ), 0 );

	}

}

function clamp01( value, fallback ) {

	return Number.isFinite( Number( value ) ) ? Math.min( 1, Math.max( 0, Number( value ) ) ) : fallback;

}

function boostMetalEnvironment( material ) {

	// 环境贴图同时喂高光和漫反射。金属没有漫反射，亮度全靠反射环境，弱环境下
	// 会渲成一团黑；而白色塑料件以漫反射为主，同样的加成会把它冲成一片死白。
	// 所以加成按金属度平方给：0.92 的近镜面金属拿 ~4.4 倍，0.2 的漆面件只拿
	// 1.16 倍，纯介电件原样不动。逐材质给，别动全局 environmentIntensity。
	const metalness = Number( material.metalness ) || 0;
	material.envMapIntensity = 1 + 5 * metalness * metalness;

}

function configureOmniPBR( material, specs, shaderPath, textureLoader, textureSet, textureCache, assetBase, warn, meshPath ) {

	material.opacity = 1;
	material.transparent = false;
	material.depthWrite = true;

	const scale = asArray( attribute( specs, shaderPath, 'inputs:texture_scale', [ 1, 1 ] ), [ 1, 1 ] );
	const translate = asArray( attribute( specs, shaderPath, 'inputs:texture_translate', [ 0, 0 ] ), [ 0, 0 ] );
	const rotate = Number( attribute( specs, shaderPath, 'inputs:texture_rotate', 0 ) );
	const transform = [
		Number( scale[ 0 ] ) || 1,
		Number( scale[ 1 ] ) || 1,
		Number( translate[ 0 ] ) || 0,
		Number( translate[ 1 ] ) || 0,
		Number.isFinite( rotate ) ? rotate * DEG : 0,
	];
	const loadTexture = ( input, colorSpace = NoColorSpace ) => {

		const path = attribute( specs, shaderPath, input, '' );
		if ( ! path || typeof Image === 'undefined' ) return null;
		const url = assetUrl( assetBase, path );
		const key = [ url, colorSpace, ...transform ].join( '|' );
		if ( textureCache.has( key ) ) return textureCache.get( key );

		const texture = textureLoader.load( url, undefined, undefined, () => {

			warn( 'texture_load_failed', `Texture failed to load: ${url}`, { usdPath: meshPath, url } );

		} );
		texture.colorSpace = colorSpace;
		texture.repeat.set( transform[ 0 ], transform[ 1 ] );
		texture.offset.set( transform[ 2 ], transform[ 3 ] );
		texture.rotation = transform[ 4 ];
		textureCache.set( key, texture );
		textureSet.add( texture );
		return texture;

	};

	const diffuseTexture = loadTexture( 'inputs:diffuse_texture', SRGBColorSpace );
	const diffuse = asArray( attribute( specs, shaderPath, 'inputs:diffuse_color_constant', [ 0.8, 0.8, 0.8 ] ), [ 0.8, 0.8, 0.8 ] );

	if ( diffuseTexture ) {

		material.map = diffuseTexture;
		material.color.setRGB( 1, 1, 1, SRGBColorSpace );

	} else {

		material.color.setRGB(
			Number( diffuse[ 0 ] ) || 0,
			Number( diffuse[ 1 ] ) || 0,
			Number( diffuse[ 2 ] ) || 0,
			SRGBColorSpace,
		);
		if ( attribute( specs, shaderPath, 'inputs:diffuse_texture', '' ) ) {

			warn( 'texture_environment_unavailable', 'Image loading is unavailable; using OmniPBR color fallback.', { usdPath: meshPath } );

		}

	}

	material.roughness = clamp01( attribute( specs, shaderPath, 'inputs:reflection_roughness_constant', 0.35 ), 0.35 );
	material.metalness = clamp01( attribute( specs, shaderPath, 'inputs:metallic_constant', 0 ), 0 );
	boostMetalEnvironment( material );
	const roughnessMap = loadTexture( 'inputs:reflectionroughness_texture' );
	if ( roughnessMap ) {

		material.roughnessMap = roughnessMap;
		material.roughness = 1;

	}
	const metalnessMap = loadTexture( 'inputs:metallic_texture' );
	if ( metalnessMap ) {

		material.metalnessMap = metalnessMap;
		material.metalness = 1;

	}
	material.normalMap = loadTexture( 'inputs:normalmap_texture' );

	if ( attribute( specs, shaderPath, 'inputs:enable_emission', false ) ) {

		const emissive = asArray( attribute( specs, shaderPath, 'inputs:emissive_color', [ 1, 1, 1 ] ), [ 1, 1, 1 ] );
		material.emissive.setRGB( emissive[ 0 ], emissive[ 1 ], emissive[ 2 ], SRGBColorSpace );
		material.emissiveIntensity = Math.max( 0, Number( attribute( specs, shaderPath, 'inputs:emissive_intensity', 1 ) ) || 1 );

	}

	if ( attribute( specs, shaderPath, 'inputs:enable_opacity', false ) ) {

		material.opacity = clamp01( attribute( specs, shaderPath, 'inputs:opacity_constant', 1 ), 1 );
		material.transparent = material.opacity < 1;
		material.depthWrite = ! material.transparent;

	}

}

function configureOmniGlass( material, specs, shaderPath ) {

	const color = asArray( attribute( specs, shaderPath, 'inputs:glass_color', [ 0.12, 0.14, 0.16 ] ), [ 0.12, 0.14, 0.16 ] );
	material.color.setRGB( Number( color[ 0 ] ) || 0, Number( color[ 1 ] ) || 0, Number( color[ 2 ] ) || 0, SRGBColorSpace );
	material.metalness = 0;
	material.roughness = 0.08;
	material.ior = Math.min( 2.333, Math.max( 1, Number( attribute( specs, shaderPath, 'inputs:glass_ior', 1.5 ) ) || 1.5 ) );
	material.transmission = 0.85;
	material.opacity = 0.35;
	material.transparent = true;
	material.depthWrite = false;

}

function applyMaterials( root, specs, objectsByPath, assetBase, warn, textureSet ) {

	const textureLoader = new TextureLoader();
	const textureCache = new Map();

	root.traverse( ( mesh ) => {

		if ( ! mesh.isMesh ) return;
		const meshPath = mesh.userData.usdPath;
		const meshMaterialPath = target( specs, meshPath, 'material:binding' );
		const materials = [].concat( mesh.material || [] );

		for ( const material of materials ) {

			material.side = DoubleSide;
			const materialPath = material.userData.usdMaterialPath || meshMaterialPath;
			if ( ! materialPath ) continue;
			const shaderPath = shaderForMaterial( specs, materialPath );
			if ( ! shaderPath ) {

				warn( 'material_shader_missing', `No shader found for ${materialPath}.`, { usdPath: meshPath } );
				continue;

			}
			const source = String( attribute( specs, shaderPath, 'info:mdl:sourceAsset', '' ) );
			if ( source.endsWith( 'OmniPBR.mdl' ) ) {

				configureOmniPBR( material, specs, shaderPath, textureLoader, textureSet, textureCache, assetBase, warn, meshPath );

			} else if ( source.endsWith( 'OmniGlass.mdl' ) ) {

				configureOmniGlass( material, specs, shaderPath );

			} else if ( String( attribute( specs, shaderPath, 'info:id', '' ) ) === 'UsdPreviewSurface' ) {

				configureUsdPreviewSurface( material, specs, shaderPath, textureLoader, textureSet, assetBase, warn, meshPath );

			} else {

				warn( 'material_fallback', `Unsupported MDL material: ${source || materialPath}.`, { usdPath: meshPath } );

			}
			material.needsUpdate = true;

		}

	} );

	// Keep this parameter intentional: callers can use the path map while debugging.
	void objectsByPath;

}

function axisVector( token ) {

	if ( token === 'X' ) return new Vector3( 1, 0, 0 );
	if ( token === 'Y' ) return new Vector3( 0, 1, 0 );
	if ( token === 'Z' ) return new Vector3( 0, 0, 1 );
	return new Vector3();

}

function frameMatrix( object, position, rotation ) {

	const local = new Matrix4().compose( position, rotation, new Vector3( 1, 1, 1 ) );
	return new Matrix4().multiplyMatrices( object.matrixWorld, local );

}

function frameError( a, b, axis ) {

	const pa = new Vector3();
	const pb = new Vector3();
	const qa = new Quaternion();
	const qb = new Quaternion();
	const scale = new Vector3();
	a.decompose( pa, qa, scale );
	b.decompose( pb, qb, scale );
	const axisA = axis.clone().applyQuaternion( qa ).normalize();
	const axisB = axis.clone().applyQuaternion( qb ).normalize();
	const delta = qa.clone().invert().multiply( qb ).normalize();
	return {
		position: pa.distanceTo( pb ),
		angle: 2 * Math.acos( Math.min( 1, Math.abs( delta.w ) ) ),
		axisAngle: Math.acos( Math.max( - 1, Math.min( 1, axisA.dot( axisB ) ) ) ),
	};

}

function jointType( usdType ) {

	if ( usdType === 'PhysicsRevoluteJoint' ) return 'revolute';
	if ( usdType === 'PhysicsPrismaticJoint' ) return 'prismatic';
	if ( usdType === 'PhysicsFixedJoint' ) return 'fixed';
	return null;

}

function orderedJointSpecs( specs ) {

	return Object.entries( specs )
		.filter( ( [ , spec ] ) => spec.specType === PRIM_SPEC && String( spec.fields.typeName || '' ).startsWith( 'Physics' ) && String( spec.fields.typeName ).endsWith( 'Joint' ) )
		.sort( ( a, b ) => {

			const af = a[ 1 ].fields.typeName === 'PhysicsFixedJoint' ? 0 : 1;
			const bf = b[ 1 ].fields.typeName === 'PhysicsFixedJoint' ? 0 : 1;
			return af - bf || a[ 0 ].localeCompare( b[ 0 ] );

		} );

}

function buildJoints( root, specs, objectsByPath, unitScale, warn ) {

	const joints = [];
	const claimedChildren = new Map();
	const world = objectsByPath.get( '/World' ) || root;
	let worldAnchors = 0;

	root.updateMatrixWorld( true );

	for ( const [ usdPath, spec ] of orderedJointSpecs( specs ) ) {

		const type = jointType( spec.fields.typeName );
		if ( ! type ) {

			warn( 'unsupported_joint', `Unsupported joint type: ${spec.fields.typeName}.`, { usdPath } );
			continue;

		}

		const body0Path = target( specs, usdPath, 'physics:body0' );
		const body1Path = target( specs, usdPath, 'physics:body1' );
		if ( ! body1Path ) {

			warn( 'empty_body1', 'Joint has no body1; it was not made operable.', { usdPath, body0: body0Path } );
			continue;

		}

		if ( claimedChildren.has( body1Path ) ) {

			warn( 'multiple_parent', `body1 is already driven by ${claimedChildren.get( body1Path )}.`, { usdPath, body1: body1Path } );
			continue;

		}

		const parentObject = body0Path ? objectsByPath.get( body0Path ) : world;
		const childObject = objectsByPath.get( body1Path );
		if ( ! parentObject || ! childObject ) {

			warn( 'missing_body', 'Joint references a body absent from the composed scene.', {
				usdPath,
				body0: body0Path,
				body1: body1Path,
			} );
			continue;

		}
		if ( ! body0Path ) worldAnchors ++;

		if ( parentObject === childObject || childObject.getObjectById( parentObject.id ) ) {

			warn( 'joint_cycle', 'Joint would create a scene-graph cycle; it was not made operable.', { usdPath } );
			continue;

		}

		const pos0 = vector3( attribute( specs, usdPath, 'physics:localPos0', [ 0, 0, 0 ] ) );
		const rot0 = quaternion( attribute( specs, usdPath, 'physics:localRot0', [ 0, 0, 0, 1 ] ) );
		const pos1 = vector3( attribute( specs, usdPath, 'physics:localPos1', [ 0, 0, 0 ] ) );
		const rot1 = quaternion( attribute( specs, usdPath, 'physics:localRot1', [ 0, 0, 0, 1 ] ) );
		const axisToken = String( attribute( specs, usdPath, 'physics:axis', 'X' ) );
		const axis = axisVector( axisToken );
		if ( axis.lengthSq() === 0 ) warn( 'invalid_joint_axis', `Unknown joint axis: ${axisToken}.`, { usdPath } );

		root.updateMatrixWorld( true );
		const error = frameError(
			frameMatrix( parentObject, pos0, rot0 ),
			frameMatrix( childObject, pos1, rot1 ),
			axis,
		);
		error.twistOnly = type === 'revolute'
			&& error.position <= FRAME_POSITION_EPS
			&& error.axisAngle <= FRAME_ANGLE_EPS
			&& error.angle > FRAME_ANGLE_EPS;
		if ( error.twistOnly ) {

			warn( 'joint_twist_offset', 'Revolute frames share a pivot and axis but use different angular zero references.', {
				usdPath,
				frameError: error,
				severity: 'info',
			} );

		} else if ( error.position > FRAME_POSITION_EPS || error.angle > FRAME_ANGLE_EPS ) {

			warn( 'joint_frame_mismatch', 'body0/body1 joint frames do not coincide; zero pose is preserved without correction.', {
				usdPath,
				frameError: error,
			} );

		}

		const pivot = new Object3D();
		pivot.name = `${basename( body1Path ) || basename( usdPath )}_pivot`;
		pivot.userData.usdPath = usdPath;
		pivot.position.copy( pos0 );
		pivot.quaternion.copy( rot0 );
		parentObject.add( pivot );
		root.updateMatrixWorld( true );
		pivot.attach( childObject );
		root.updateMatrixWorld( true );

		let lower = Number( attribute( specs, usdPath, 'physics:lowerLimit', - Infinity ) );
		let upper = Number( attribute( specs, usdPath, 'physics:upperLimit', Infinity ) );
		if ( type === 'revolute' ) {

			lower *= DEG;
			upper *= DEG;

		} else if ( type === 'prismatic' ) {

			lower *= unitScale;
			upper *= unitScale;

		} else {

			lower = 0;
			upper = 0;

		}
		if ( lower > upper ) [ lower, upper ] = [ upper, lower ];
		if ( type !== 'fixed' && ( lower > 0 || upper < 0 ) ) {

			warn( 'zero_outside_limits', 'Authored limits exclude the USD zero pose; setValue(0) still restores q=0.', {
				usdPath,
				lower,
				upper,
			} );

		}

		const basePosition = pivot.position.clone();
		const baseQuaternion = pivot.quaternion.clone();
		const screwPitch = type === 'revolute'
			? Number( attribute( specs, usdPath, 'articraft:screwPitch', 0 ) ) * unitScale
			: 0;
		const worldOrigin = new Vector3();
		const worldTarget = new Vector3();
		const worldAxis = new Vector3();
		const joint = {
			id: basename( body1Path ) || usdPath,
			type,
			parent: basename( body0Path || '/World' ),
			child: basename( body1Path ),
			axis: axis.toArray(),
			lower,
			upper,
			value: 0,
			pivot,
			frameError: error,
			usdPath,
			screwPitch,
			setValue: null,
			setValueUnclamped: null,
			reset: null,
		};

		const applyValue = ( requested, clampToLimits ) => {

			let value = Number( requested );
			if ( ! Number.isFinite( value ) ) return joint.value;
			if ( clampToLimits ) {

				if ( Number.isFinite( lower ) ) value = Math.max( lower, value );
				if ( Number.isFinite( upper ) ) value = Math.min( upper, value );

			}

			pivot.position.copy( basePosition );
			pivot.quaternion.copy( baseQuaternion );
			if ( type === 'revolute' ) {

				pivot.quaternion.multiply( new Quaternion().setFromAxisAngle( axis, value ) );
				if ( screwPitch ) {

					pivot.updateWorldMatrix( true, false );
					worldOrigin.setFromMatrixPosition( pivot.matrixWorld );
					worldAxis.copy( axis ).transformDirection( pivot.matrixWorld );
					worldTarget.copy( worldOrigin ).addScaledVector( worldAxis, value * screwPitch / ( 2 * Math.PI ) );
					parentObject.worldToLocal( worldTarget );
					pivot.position.copy( worldTarget );

				}

			} else if ( type === 'prismatic' ) {

				// Joint values are exposed in meters. Convert that world-space distance
				// back into the parent's local coordinates so nested xform scales do not
				// shrink or magnify the requested travel.
				pivot.updateWorldMatrix( true, false );
				worldOrigin.setFromMatrixPosition( pivot.matrixWorld );
				worldAxis.copy( axis ).transformDirection( pivot.matrixWorld );
				worldTarget.copy( worldOrigin ).addScaledVector( worldAxis, value );
				parentObject.worldToLocal( worldTarget );
				pivot.position.copy( worldTarget );

			}
			pivot.updateMatrixWorld( true );
			joint.value = value;
			return value;

		};

		joint.setValue = ( value ) => Number( value ) === 0 ? applyValue( 0, false ) : applyValue( value, true );
		joint.setValueUnclamped = ( value ) => applyValue( value, false );
		joint.reset = () => applyValue( 0, false );
		joints.push( joint );
		claimedChildren.set( body1Path, usdPath );

	}
	if ( worldAnchors > 1 ) {

		warn( 'multiple_roots', `Physics graph has ${worldAnchors} world-anchored roots; all are preserved.`, { count: worldAnchors } );

	}

	const bodyPaths = Object.entries( specs )
		.filter( ( [ , spec ] ) => spec.specType === PRIM_SPEC && spec.fields.typeName === 'Mesh' )
		.map( ( [ path ] ) => path );
	for ( const path of bodyPaths ) {

		if ( ! claimedChildren.has( path ) ) {

			warn( 'disconnected_body', 'Mesh has no usable incoming physics joint.', { usdPath: path } );

		}

	}

	return joints;

}

function buildPartMap( root, gtParts, warn ) {

	const meshesByPart = new Map();
	root.traverse( ( mesh ) => {

		if ( ! mesh.isMesh ) return;
		const id = basename( mesh.userData.usdPath ) || mesh.name;
		if ( ! meshesByPart.has( id ) ) meshesByPart.set( id, [] );
		meshesByPart.get( id ).push( mesh );

	} );

	const labelsByPart = new Map();
	for ( const [ label, part ] of Object.entries( gtParts || {} ) ) {

		if ( ! labelsByPart.has( part ) ) labelsByPart.set( part, [] );
		labelsByPart.get( part ).push( label );

	}

	for ( const [ part, labels ] of labelsByPart ) {

		const meshes = meshesByPart.get( part );
		if ( ! meshes ) {

			warn( 'gt_part_missing_mesh', `GT part ${part} has no composed mesh.`, { part, labels } );
			continue;

		}
		for ( const mesh of meshes ) mesh.userData.gtLabels = labels.slice();

	}

	return meshesByPart;

}

function makeDispose( root, textureSet ) {

	let disposed = false;
	return () => {

		if ( disposed ) return;
		disposed = true;
		root.removeFromParent();

		const geometries = new Set();
		const materials = new Set();
		root.traverse( ( object ) => {

			if ( object.geometry ) geometries.add( object.geometry );
			for ( const material of [].concat( object.material || [] ) ) materials.add( material );

		} );
		for ( const geometry of geometries ) geometry.dispose();
		for ( const material of materials ) material.dispose();
		for ( const texture of textureSet ) texture.dispose();

	};

}

/**
 * Compose an already downloaded RealAppliance USDC buffer.
 * Useful for tests and callers that own their fetch/cache layer.
 */
function parseRealAppliance( buffer, { assetBase = '', gtParts = {}, onProgress = null } = {} ) {

	const warnings = [];
	const warn = ( code, message, details = {} ) => {

		const warning = { code, message, ...details };
		warnings.push( warning );
		if ( onProgress ) onProgress( { phase: 'warning', warning } );

	};

	report( onProgress, 'parse' );
	const parsed = new USDCParser().parseData( buffer );
	const specs = parsed.specsByPath;
	const rootFields = specs[ '/' ]?.fields || {};
	const unitScale = Number( rootFields.metersPerUnit ) || 1;

	report( onProgress, 'compose' );
	const root = new USDComposer().compose( parsed, {} );
	root.name = 'RealAppliance';
	root.scale.multiplyScalar( unitScale );
	root.userData.usdPath = '/';
	root.userData.metersPerUnit = unitScale;
	root.userData.upAxis = rootFields.upAxis || 'Y';

	const objectsByPath = new Map( [ [ '/', root ] ] );
	tagUsdPaths( root, '/', objectsByPath );
	const textureSet = new Set();
	applyMaterials( root, specs, objectsByPath, assetBase, warn, textureSet );
	const meshesByPart = buildPartMap( root, gtParts, warn );
	const joints = buildJoints( root, specs, objectsByPath, unitScale, warn );

	report( onProgress, 'ready' );
	return {
		root,
		meshesByPart,
		joints,
		warnings,
		dispose: makeDispose( root, textureSet ),
	};

}

/**
 * Load a RealAppliance Aligned.usd file directly in the browser.
 * onProgress receives { phase, loaded, total }.
 */
async function loadRealAppliance( { url, assetBase = '', gtParts = {}, onProgress = null, signal } ) {

	if ( ! url ) throw new TypeError( 'loadRealAppliance requires url' );
	const buffer = await fetchBuffer( url, onProgress, signal );
	const base = assetBase || url.slice( 0, url.lastIndexOf( '/' ) + 1 );
	return parseRealAppliance( buffer, { assetBase: base, gtParts, onProgress } );

}

export { loadRealAppliance, parseRealAppliance };
