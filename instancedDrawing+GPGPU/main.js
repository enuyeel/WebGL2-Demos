import { glMatrix, mat4, vec3 } from "gl-matrix";
import { OBJLoader } from "@loaders.gl/obj";
import { load } from "@loaders.gl/core";
import Stats from "stats.js";
import * as dat from "dat.gui";

/*
  ! Seemingly two approaches
  ! #1 Use Shader Storage Buffer Object (SSBO), and bind it to the output of the compute shader.
  ! #2 Use texture and fill it from the fragment shader pass. Then, sample it from the vertex shader when instancing. <- Not utilizing compute shader, thus not to enable an extra extension for browsers.
*/

const screenQuadVertexShaderSource = 
  `#version 300 es
  
  layout (location = 0) in vec2 quadVertexModelPosition;
  
  void main() {
    gl_Position = vec4(quadVertexModelPosition, 0., 1.);
  }`;

const GPGPUFragmentShaderSource = 
  `#version 300 es

  #define M_PI 3.1415926535897932384626433832795

  precision mediump float;
  
  //.xy: asteroid's position vector
  layout (location = 0) out vec4 asteroidData;

  uniform int   textureDimension;
  uniform int   asteroidCount;
  uniform float elapsedTime;
  uniform float radius;
  uniform float minRadius;

  //! [https://graphtoy.com/?f1(x,t)=fract(x%20*%20.1031)&v1=false&f2(x,t)=f1(x)%20*%20(f1(x)%20+%2033.33)&v2=false&f3(x,t)=f2(x)%20*%20(f2(x)%20+%20f2(x))&v3=false&f4(x,t)=fract(f3(x))&v4=true&f5(x,t)=&v5=false&f6(x,t)=&v6=false&grid=1&coords=0.2431201500521052,0.41137848291959966,0.6251842178309247]
  //! [https://www.shadertoy.com/view/4djSRW]
  float hash11(float p)
  {
    p = fract(p * .1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  int calculateIndex()
  {
    ivec2 fragCoord = ivec2(gl_FragCoord.xy);
    return fragCoord.y * textureDimension + fragCoord.x;
  }

  void main() {

    int index = calculateIndex();

    if (index < asteroidCount &&
        //asteroidCount <= textureDimension * textureDimension)
        index < textureDimension * textureDimension)
    {
      // float hash0 = hash11( float(index) + hash11(float(index)) );
      float hash0 = hash11( float(index) );
      float hash1 = hash11( float(index) + hash0 );
      float theta = hash0 * 2. * M_PI + elapsedTime * 0.1;
      asteroidData.xy = (minRadius + float(int((hash1 * radius) / 0.6)) * 0.6) * vec2(cos(theta), sin(theta));

      float hash2 = hash11(float(index) + hash1);
      float hash3 = hash11(float(index) + hash2);
      asteroidData.zw = vec2(hash2, hash3);
    }

  }`;

const instancedDrawingVertexShaderSource = 
  `#version 300 es

  layout (location = 0) in vec3 vertexModelPosition;
  layout (location = 1) in vec2 vertexUV;

  uniform sampler2D asteroidData;
  uniform mat4 wtoc;
  uniform mat4 ctoc;
  uniform float elapsedTime;

  out vec2 fragmentUV;

  ivec2 calculateIndex()
  {
    int textureDimension = textureSize(asteroidData, 0).x;
    ivec2 index = ivec2(0);
    
    index.x = gl_InstanceID % textureDimension;
    index.y = gl_InstanceID / textureDimension;

    return index;
  }

  void main() {

    fragmentUV = vertexUV;

    ivec2 index = calculateIndex();
    vec4 data = texelFetch(asteroidData, index, 0).xyzw;

    vec3 u = vec3(
      data.z, data.w, 
      sqrt(1. - ( data.z * data.z + data.w * data.w ))
    );
    
    float ct = cos(elapsedTime);
    float st = sin(elapsedTime);

    mat4 mtow = mat4(

      ct + u.x * u.x * (1. - ct), 
      u.x * u.y * (1. - ct) - u.z * st, 
      u.x * u.z * (1. - ct) + u.y * st, 
      data.x,

      u.y * u.x * (1. - ct) + u.z * st,
      ct + u.y * u.y * (1. - ct),
      u.y * u.z * (1. - ct) - u.x * st, 
      0.,

      u.z * u.x * (1. - ct) - u.y * st,
      u.z * u.y * (1. - ct) + u.x * st,
      ct + u.z * u.z * (1. - ct),
      data.y,

      0., 0., 0., 1.

    );
    mtow = transpose(mtow);

    gl_Position = ctoc * wtoc * mtow * vec4(vertexModelPosition, 1.);

  }`;

const instancedDrawingFragmentShaderSource = 
  `#version 300 es

  precision mediump float;
  
  uniform sampler2D diffuseTexture;

  in vec2 fragmentUV;

  out vec4 outputColor;

  void main() {

    vec3 diffuse = texture(diffuseTexture, fragmentUV).rgb;
    outputColor = vec4(diffuse, 1.);
    
  }`;

let stats;
let gui;
let gl;

let aspectRatio;
let FoVy           = glMatrix.toRadian(90.);
let zNear          = 0.001;
let zFar           = 1000.;
let cameraPosition = vec3.fromValues(0., 5., 15.);
//let cameraPosition = vec3.fromValues(0., 1., 1.);
let wtoc           = mat4.create();
let ctoc           = mat4.create();

let asteroidCount  = 100;
let minRadius      = 1;
let fieldWidth     = 10;

let last = 0.;

let instancedDrawingPass = 
{
  vertexShader: null,
  fragmentShader: null,
  program: null,
  VAO: null,
  BO0: null,
  BO1: null,
  texture: null,

  vertexCount: null,
  wtocLoc: null,
  ctocLoc: null,
  asteroidDataLoc: null,
  elapsedTimeLoc: null,
  //minRadiusLoc: null,
  diffuseTextureLoc: null,
};

let GPGPUPass =
{
  //* resources need to be released
  vertexShader: null,
  fragmentShader: null,
  program: null,
  fbo: null,
  attachment0: null,
  attachment1: null,

  textureDimension: 256,

  minRadiusLoc: null,
  textureDimensionLoc: null,
  asteroidCountLoc: null,
  elapsedTimeLoc: null,
  radiusLoc: null,
};

const screenQuadModelVertices = new Float32Array(
  [
     1., -1.,
    -1., -1.,
    -1.,  1.,

     1., -1.,
    -1.,  1.,
     1.,  1.,
  ]
);

let screenQuad =
{
  VAO: null,
  BO0: null,
}

//TODO It can be generated within the loop with a couple of parameters to control the shape.
const unitBoxModelVertices = new Float32Array(
  [
    // -0.25, -1.,   0.25, -1.,  -0.25, -0.5,
    //  0.25, -1.,  -0.25, -0.5,  0.25, -0.5,
    // -0.25, -0.5,  0.25, -0.5, -0.25,  0.,
    //  0.25, -0.5, -0.25,  0.,   0.25,  0.,
    // -0.25,  0.,   0.25,  0.,  -0.25,  0.5,
    //  0.25,  0.,  -0.25,  0.5,  0.25,  0.5,
    // -0.25,  0.5,  0.25,  0.5,  0.,    1.

     0.5, -0.5,
    -0.5, -0.5,
    -0.5,  0.5,

     0.5, -0.5,
    -0.5,  0.5,
     0.5,  0.5,
  ]
);

function onWindowResize() {

  gl.canvas.width = gl.canvas.clientWidth;
  gl.canvas.height = gl.canvas.clientHeight;

  aspectRatio = gl.canvas.width / gl.canvas.height;

  //! lookAt(out, eye, center, up) → {mat4}
  mat4.lookAt(wtoc, cameraPosition, vec3.create(0., 0., 0.), vec3.fromValues(0., 1., 0.));
  //wtoc = mat4.create();
  //! perspective(out, fovy, aspect, near, far) → {mat4}
  mat4.perspective(ctoc, FoVy, aspectRatio, zNear, zFar);
  //ctoc = mat4.create();

  gl.useProgram(instancedDrawingPass.program);
  gl.uniformMatrix4fv(instancedDrawingPass.wtocLoc, false, wtoc);
  gl.uniformMatrix4fv(instancedDrawingPass.ctocLoc, false, ctoc);
  gl.useProgram(null);

  gl.viewport( 0., 0., gl.canvas.width, gl.canvas.height );
}

function initScreenQuad()
{
  screenQuad.VAO = gl.createVertexArray();
  gl.bindVertexArray(screenQuad.VAO);

  screenQuad.BO0 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, screenQuad.BO0);
  gl.bufferData(gl.ARRAY_BUFFER, screenQuadModelVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  //TODO No need for unbinding in WebGL2?
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  gl.bindVertexArray(null);

  console.log("initScreenQuad");
}

function checkFramebufferStatus()
{
  let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  switch (status) {
    case gl.FRAMEBUFFER_COMPLETE:
      console.log("Framebuffer is complete");
      break;
    case gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT:
      console.error("Framebuffer incomplete attachment");
      break;
    case gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:
      console.error("Framebuffer incomplete missing attachment");
      break;
    case gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:
      console.error("Framebuffer incomplete multisample");
      break;
    case gl.FRAMEBUFFER_UNSUPPORTED:
      console.error("Framebuffer unsupported");
      break;
    default:
      console.error("Unknown framebuffer status");
      break;
  }
}

function initGPGPUPass()
{
  GPGPUPass.fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, GPGPUPass.fbo);

  GPGPUPass.attachment0 = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, GPGPUPass.attachment0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GPGPUPass.textureDimension, GPGPUPass.textureDimension, 0, gl.RGBA, gl.FLOAT, null);
  //TODO 
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, GPGPUPass.attachment0, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  checkFramebufferStatus();

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  GPGPUPass.vertexShader = compileShader(gl, screenQuadVertexShaderSource, gl.VERTEX_SHADER);
  GPGPUPass.fragmentShader = compileShader(gl, GPGPUFragmentShaderSource, gl.FRAGMENT_SHADER);
  GPGPUPass.program = createProgram(gl, GPGPUPass.vertexShader, GPGPUPass.fragmentShader);

  GPGPUPass.textureDimensionLoc = gl.getUniformLocation(GPGPUPass.program, 'textureDimension');
  GPGPUPass.asteroidCountLoc    = gl.getUniformLocation(GPGPUPass.program, 'asteroidCount');
  GPGPUPass.elapsedTimeLoc      = gl.getUniformLocation(GPGPUPass.program, 'elapsedTime');
  GPGPUPass.radiusLoc           = gl.getUniformLocation(GPGPUPass.program, 'radius');
  GPGPUPass.minRadiusLoc        = gl.getUniformLocation(GPGPUPass.program, "minRadius");

  gl.useProgram(GPGPUPass.program);

  gl.uniform1i(GPGPUPass.textureDimensionLoc, GPGPUPass.textureDimension);
  gl.uniform1i(GPGPUPass.asteroidCountLoc,    asteroidCount);
  gl.uniform1f(GPGPUPass.radiusLoc,           fieldWidth);
  gl.uniform1f(GPGPUPass.minRadiusLoc,        minRadius);

  gl.useProgram(null);

  console.log("initGPGPUPass");
}

function updateGUI()
{
  gl.useProgram(instancedDrawingPass.program);
  gl.uniformMatrix4fv(instancedDrawingPass.wtocLoc, false, wtoc);
  gl.uniformMatrix4fv(instancedDrawingPass.ctocLoc, false, ctoc);

  gl.useProgram(GPGPUPass.program);
  gl.uniform1i(GPGPUPass.asteroidCountLoc, asteroidCount);
  gl.uniform1f(GPGPUPass.radiusLoc,        fieldWidth);
  gl.uniform1f(GPGPUPass.minRadiusLoc,     minRadius);
  gl.useProgram(null);
}

function renderGPGPUPass(elapsedS)
{
  gl.bindFramebuffer(gl.FRAMEBUFFER, GPGPUPass.fbo);

  gl.useProgram(GPGPUPass.program);

  gl.uniform1f(GPGPUPass.elapsedTimeLoc, elapsedS);

  gl.bindVertexArray(screenQuad.VAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
  gl.useProgram(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

async function initInstancedDrawingPass()
{
  instancedDrawingPass.vertexShader = compileShader(gl, instancedDrawingVertexShaderSource, gl.VERTEX_SHADER);
  instancedDrawingPass.fragmentShader = compileShader(gl, instancedDrawingFragmentShaderSource, gl.FRAGMENT_SHADER);
  instancedDrawingPass.program = createProgram(gl, instancedDrawingPass.vertexShader, instancedDrawingPass.fragmentShader);

  instancedDrawingPass.wtocLoc = gl.getUniformLocation(instancedDrawingPass.program, "wtoc");
  instancedDrawingPass.ctocLoc = gl.getUniformLocation(instancedDrawingPass.program, "ctoc");
  instancedDrawingPass.asteroidDataLoc = gl.getUniformLocation(instancedDrawingPass.program, "asteroidData");
  instancedDrawingPass.diffuseTextureLoc = gl.getUniformLocation(instancedDrawingPass.program, "diffuseTexture");
  instancedDrawingPass.elapsedTimeLoc = gl.getUniformLocation(instancedDrawingPass.program, "elapsedTime");

  gl.useProgram(instancedDrawingPass.program);

  //! No wtoc & ctoc uniforms are set here.

  gl.useProgram(null);

  console.log("initInstancedDrawingPass");
  
  //! [https://webgl2fundamentals.org/webgl/lessons/webgl-3d-textures.html]

  const promise0 = await new Promise(
    (resolve, reject) => {

      var textureMetadata = new Image();
      textureMetadata.addEventListener('load', () => 
        {
          instancedDrawingPass.texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, instancedDrawingPass.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, textureMetadata.width, textureMetadata.height, 0, gl.RGB, gl.UNSIGNED_BYTE, textureMetadata);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        
          gl.bindTexture(gl.TEXTURE_2D, null);
      
          gl.useProgram(instancedDrawingPass.program);
      
          //TODO 
          gl.activeTexture(gl.TEXTURE0 + 0);
          gl.bindTexture(gl.TEXTURE_2D, GPGPUPass.attachment0);
          gl.uniform1i(instancedDrawingPass.asteroidDataLoc, 0);
      
          gl.activeTexture(gl.TEXTURE0 + 1);
          gl.bindTexture(gl.TEXTURE_2D, instancedDrawingPass.texture);
          gl.uniform1i(instancedDrawingPass.diffuseTextureLoc, 1);
        
          gl.useProgram(null);
      
          console.log("Image");

          //* It doesn't require a realized value.
          resolve();
        }
      );
      textureMetadata.onerror = reject;
      textureMetadata.src = "./rock_Base_Color.png";

    }
  );

  // const loader = new OBJLoader();
  // loader.load( "./assets/rock_by_dommk.obj",

  //   //called when resource is loaded
  //   function( object ) {

  //     let metadata = object.children[0].geometry.attributes;
  //     console.log(metadata);

  // instancedDrawingPass.count = metadata.position.count;

  //     // let size = new THREE.Vector3();
  //     // child.geometry.computeBoundingBox();
  //     // child.geometry.boundingBox.getSize( size );
  //     //var scaleFactor = 1. / size.length();
  //   }
  // );

  //! [https://loaders.gl/docs/modules/obj/api-reference/obj-loader]
  const meshMetadata = await load("./rock_by_dommk.obj", OBJLoader);

  let vertexModelPositions = meshMetadata.attributes.POSITION.value;
  const AABB = meshMetadata.header.boundingBox;
  let scaleFactor = vec3.fromValues(
    AABB[1][0] - AABB[0][0], 
    AABB[1][1] - AABB[0][1], 
    AABB[1][2] - AABB[0][2]
  );
  scaleFactor = vec3.len(scaleFactor);
  scaleFactor = 1. / scaleFactor;
  for (let i = 0; i < vertexModelPositions.length; i++) {
    vertexModelPositions[i] *= scaleFactor;
  }

  instancedDrawingPass.VAO = gl.createVertexArray();
  gl.bindVertexArray(instancedDrawingPass.VAO);

  instancedDrawingPass.vertexCount = meshMetadata.header.vertexCount;

  instancedDrawingPass.BO0 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instancedDrawingPass.BO0);
  //gl.bufferData(gl.ARRAY_BUFFER, unitBoxModelVertices, gl.STATIC_DRAW);
  gl.bufferData(gl.ARRAY_BUFFER, vertexModelPositions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  instancedDrawingPass.BO1 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instancedDrawingPass.BO1);
  //gl.bufferData(gl.ARRAY_BUFFER, unitBoxModelVertices, gl.STATIC_DRAW);
  gl.bufferData(gl.ARRAY_BUFFER, meshMetadata.attributes.TEXCOORD_0.value, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  //TODO No need for unbinding in WebGL2?
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  gl.bindVertexArray(null);

  console.log("meshMetadata");

}

function renderInstancedDrawingPass(elapsedS)
{
  gl.useProgram(instancedDrawingPass.program);

  gl.uniform1f(instancedDrawingPass.elapsedTimeLoc, elapsedS);

  gl.bindVertexArray(instancedDrawingPass.VAO);
  //gl.drawArrays(gl.TRIANGLES, 0, 6);
  //gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, asteroidCount);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, instancedDrawingPass.vertexCount, asteroidCount);
  gl.bindVertexArray(null);
  gl.useProgram(null);
}

function init()
{
  let canvas = document.createElement( "canvas" );
  canvas.setAttribute( "id", "canvas1" );
  document.body.appendChild( canvas );
  canvas = document.getElementById("canvas1");

  //! [https://www.khronos.org/webgl/wiki/Debugging]
  // gl = WebGLDebugUtils.makeDebugContext(canvas.getContext("webgl2"), 
  //   (err, funcName, args) => 
  //   {
  //     throw WebGLDebugUtils.glEnumToString(err) + " was caused by call to: " + funcName;
  //   }
  // );

  gl = canvas.getContext("webgl2");
  if (!gl) {
    alert("WebGL 2 is not supported");
    return;
  }

  //! Spector.js enables "EXT_color_buffer_float" by default, and having it on for a while and going back to vanilla confused me a bit, since the framebuffer status was dirty all of a sudden.
  let enabled = gl.getExtension("EXT_color_buffer_float");
  if (!enabled)
  {
    console.error(`"EXT_color_buffer_float" extension is not enabled`);
    return;
  }

  // const supportedExtensions = gl.getSupportedExtensions();
  // console.log(`Supported extensions: ${supportedExtensions}`);
  
  // for (let i = 0; i < supportedExtensions.length; i++) {
  //   const extensionName = supportedExtensions[i];
  //   const extension = gl.getExtension(extensionName);
    
  //   if (extension) {
  //     console.log(`${extensionName} extension is enabled`);
  //   } else {
  //     console.log(`${extensionName} extension is not enabled`);
  //   }
  // }

  //! [https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL]
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  stats = new Stats();
  stats.showPanel( 0 );
  document.body.appendChild( stats.dom );

  window.addEventListener("beforeunload", () => 
    {
      gl.deleteProgram(instancedDrawingPass.program);
      gl.deleteShader(instancedDrawingPass.vertexShader);
      gl.deleteShader(instancedDrawingPass.fragmentShader);
      gl.deleteVertexArray(instancedDrawingPass.VAO);
      gl.deleteBuffer(instancedDrawingPass.BO0);
      gl.deleteBuffer(instancedDrawingPass.BO1);
      gl.deleteBuffer(instancedDrawingPass.texture);
      
      gl.deleteProgram(GPGPUPass.program);
      gl.deleteShader(GPGPUPass.vertexShader);
      gl.deleteShader(GPGPUPass.fragmentShader);
      gl.deleteFramebuffer(GPGPUPass.fbo);
      gl.deleteTexture(GPGPUPass.attachment0);
    
      gl.deleteVertexArray(screenQuad.VAO);
      gl.deleteBuffer(screenQuad.BO0);
    }
  );

  window.addEventListener( "resize", onWindowResize );

  initScreenQuad();

  initGPGPUPass();

  initInstancedDrawingPass().then(
    () => {

      onWindowResize();

      gui = new dat.GUI();
      let params = {
        "Asteroid Count": asteroidCount,
        "Triangle Count": instancedDrawingPass.vertexCount / 3 * asteroidCount,
        "Min Radius": minRadius,
        "Field Width": fieldWidth
      };
      let triangleCount = gui.add(params, "Triangle Count").listen();
      //! [https://stackoverflow.com/questions/38602189/how-to-lock-slider-and-prevent-updating-of-values-with-mouse-into-dat-gui-menu]
      triangleCount.domElement.style.pointerEvents = "none";
      triangleCount.domElement.parentElement.style.pointerEvents = "none";
      gui.add(params, "Asteroid Count").min(100).max(50000).step(1).onChange(
        (value) => {
          asteroidCount = value;
          params["Triangle Count"] = instancedDrawingPass.vertexCount / 3 * asteroidCount;

          gl.useProgram(GPGPUPass.program);
          gl.uniform1i(GPGPUPass.asteroidCountLoc, asteroidCount);
          gl.useProgram(null);
        }
      );
      gui.add(params, "Min Radius").min(1).max(100).step(1.).onChange(
        (value) => {
          minRadius = value;
          gl.useProgram(GPGPUPass.program);
          gl.uniform1f(GPGPUPass.minRadiusLoc, minRadius);
          gl.useProgram(null);
        }
      );
      gui.add(params, "Field Width").min(1).max(100).step(1.).onChange(
        (value) => {
          fieldWidth = value;
          gl.useProgram(GPGPUPass.program);
          gl.uniform1f(GPGPUPass.radiusLoc, fieldWidth);
          gl.useProgram(null);
        }
      );
      console.log("GUI");

    }
  );

  gl.clearColor(0.0, 0.0, 0.0, 1.0);
}

//! [https://webgl2fundamentals.org/webgl/lessons/webgl-boilerplate.html]
function compileShader(gl, shaderSource, shaderType) {
  // Create the shader object
  let shader = gl.createShader(shaderType);
 
  // Set the shader source code.
  gl.shaderSource(shader, shaderSource);
 
  // Compile the shader
  gl.compileShader(shader);
 
  // Check if it compiled
  let success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!success) {
    // Something went wrong during compilation; get the error
    throw ("could not compile shader:" + gl.getShaderInfoLog(shader));
  }
 
  return shader;
}

//! [https://webgl2fundamentals.org/webgl/lessons/webgl-boilerplate.html]
function createProgram(gl, vertexShader, fragmentShader) {
  // create a program.
  let program = gl.createProgram();
 
  // attach the shaders.
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
 
  // link the program.
  gl.linkProgram(program);
 
  // Check if it linked.
  let success = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!success) {
      // something went wrong with the link; get the error
      throw ("program failed to link:" + gl.getProgramInfoLog(program));
  }
 
  return program;
};

function update(elapsedMS)
{
  let curr = elapsedMS * 0.001;

  //let delta = curr - last;

  last = curr;

	stats.begin();

  //updateGUI();

  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  //! The first GPGPU pass has its quad's vertices defined in clock-wise order.
  //! Change it to gl.CCW, to see interestingly we can still be able to see one asteroid; we'll still be able to see one if we skip the first GPGPU pass ;)
  gl.frontFace(gl.CW);

  renderGPGPUPass(curr);

  gl.frontFace(gl.CCW);

  renderInstancedDrawingPass(curr);

  stats.end();

  requestAnimationFrame(update);
}

init();

update();