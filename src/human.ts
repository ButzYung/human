import { log, now, mergeDeep } from './helpers';
import * as sysinfo from './sysinfo';
import * as tf from '../dist/tfjs.esm.js';
import * as backend from './tfjs/backend';
import * as faceall from './faceall';
import * as facemesh from './blazeface/facemesh';
import * as age from './age/age';
import * as gender from './gender/gender';
import * as faceres from './faceres/faceres';
import * as emotion from './emotion/emotion';
import * as embedding from './embedding/embedding';
import * as posenet from './posenet/posenet';
import * as handpose from './handpose/handpose';
import * as blazepose from './blazepose/blazepose';
import * as efficientpose from './efficientpose/efficientpose';
import * as nanodet from './nanodet/nanodet';
import * as gesture from './gesture/gesture';
import * as image from './image/image';
import * as draw from './draw/draw';
import * as profile from './profile';
import { Config, defaults } from './config';
import { Result } from './result';
import * as sample from './sample';
import * as app from '../package.json';

/** Generic Tensor object type */
export type Tensor = typeof tf.Tensor;
export type { Config } from './config';
export type { Result } from './result';
/** Defines all possible input types for **Human** detection */
export type Input = Tensor | ImageData | ImageBitmap | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;
/** Error message */
export type Error = { error: string };
/** Instance of TensorFlow/JS */
export type TensorFlow = typeof tf;
/** Generic Model object type, holds instance of individual models */
type Model = Object;

/**
 * **Human** library main class
 *
 * All methods and properties are available only as members of Human class
 *
 * - Configuration object definition: {@link Config}
 * - Results object definition: {@link Result}
 * - Possible inputs: {@link Input}
 */
export class Human {
  version: string;
  config: Config;
  state: string;
  image: { tensor: Tensor, canvas: OffscreenCanvas | HTMLCanvasElement };
  // classes
  tf: TensorFlow;
  draw: {
    drawOptions?: typeof draw.drawOptions,
    gesture: typeof draw.gesture,
    face: typeof draw.face,
    body: typeof draw.body,
    hand: typeof draw.hand,
    canvas: typeof draw.canvas,
    all: typeof draw.all,
  };
  // models
  models: {
    face: facemesh.MediaPipeFaceMesh | Model | null,
    posenet: posenet.PoseNet | null,
    blazepose: Model | null,
    efficientpose: Model | null,
    handpose: handpose.HandPose | null,
    iris: Model | null,
    age: Model | null,
    gender: Model | null,
    emotion: Model | null,
    embedding: Model | null,
    nanodet: Model | null,
    faceres: Model | null,
  };
  classes: {
    facemesh: typeof facemesh;
    age: typeof age;
    gender: typeof gender;
    emotion: typeof emotion;
    body: typeof posenet | typeof blazepose;
    hand: typeof handpose;
    nanodet: typeof nanodet;
    faceres: typeof faceres;
  };
  sysinfo: { platform: string, agent: string };
  perf: any;
  #numTensors: number;
  #analyzeMemoryLeaks: boolean;
  #checkSanity: boolean;
  #firstRun: boolean;
  // definition end

  constructor(userConfig: Config | Object = {}) {
    this.tf = tf;
    this.draw = draw;
    this.version = app.version;
    this.config = mergeDeep(defaults, userConfig);
    this.state = 'idle';
    this.#numTensors = 0;
    this.#analyzeMemoryLeaks = false;
    this.#checkSanity = false;
    this.#firstRun = true;
    this.perf = {};
    // object that contains all initialized models
    this.models = {
      face: null,
      posenet: null,
      blazepose: null,
      efficientpose: null,
      handpose: null,
      iris: null,
      age: null,
      gender: null,
      emotion: null,
      embedding: null,
      nanodet: null,
      faceres: null,
    };
    // export access to image processing
    // @ts-ignore
    this.image = (input: Input) => image.process(input, this.config);
    // export raw access to underlying models
    this.classes = {
      facemesh,
      age,
      gender,
      emotion,
      faceres,
      body: this.config.body.modelPath.includes('posenet') ? posenet : blazepose,
      hand: handpose,
      nanodet,
    };
    // include platform info
    this.sysinfo = sysinfo.info();
  }

  profileData(): { newBytes, newTensors, peakBytes, numKernelOps, timeKernelOps, slowestKernelOps, largestKernelOps } | {} {
    if (this.config.profile) return profile.data;
    return {};
  }

  // helper function: measure tensor leak
  /** @hidden */
  analyze = (...msg) => {
    if (!this.#analyzeMemoryLeaks) return;
    const current = this.tf.engine().state.numTensors;
    const previous = this.#numTensors;
    this.#numTensors = current;
    const leaked = current - previous;
    if (leaked !== 0) log(...msg, leaked);
  }

  // quick sanity check on inputs
  /** @hidden */
  #sanity = (input): null | string => {
    if (!this.#checkSanity) return null;
    if (!input) return 'input is not defined';
    if (this.tf.ENV.flags.IS_NODE && !(input instanceof tf.Tensor)) return 'input must be a tensor';
    try {
      this.tf.getBackend();
    } catch {
      return 'backend not loaded';
    }
    return null;
  }

  similarity(embedding1: Array<number>, embedding2: Array<number>): number {
    if (this.config.face.description.enabled) return faceres.similarity(embedding1, embedding2);
    if (this.config.face.embedding.enabled) return embedding.similarity(embedding1, embedding2);
    return 0;
  }

  // eslint-disable-next-line class-methods-use-this
  enhance(input: Tensor): Tensor | null {
    return faceres.enhance(input);
  }

  // eslint-disable-next-line class-methods-use-this
  match(faceEmbedding: Array<number>, db: Array<{ name: string, source: string, embedding: number[] }>, threshold = 0): { name: string, source: string, similarity: number, embedding: number[] } {
    return faceres.match(faceEmbedding, db, threshold);
  }

  // preload models, not explicitly required as it's done automatically on first use
  async load(userConfig: Config | Object = {}) {
    this.state = 'load';
    const timeStamp = now();
    if (userConfig) this.config = mergeDeep(this.config, userConfig);

    if (this.#firstRun) {
      if (this.config.debug) log(`version: ${this.version}`);
      if (this.config.debug) log(`tfjs version: ${this.tf.version_core}`);
      if (this.config.debug) log('platform:', this.sysinfo.platform);
      if (this.config.debug) log('agent:', this.sysinfo.agent);

      await this.#checkBackend(true);
      if (this.tf.ENV.flags.IS_BROWSER) {
        if (this.config.debug) log('configuration:', this.config);
        if (this.config.debug) log('tf flags:', this.tf.ENV.flags);
      }
    }
    if (this.config.async) {
      [
        this.models.face,
        this.models.age,
        this.models.gender,
        this.models.emotion,
        this.models.embedding,
        // @ts-ignore
        this.models.handpose,
        // @ts-ignore false warning with latest @typescript-eslint
        this.models.posenet,
        this.models.blazepose,
        this.models.efficientpose,
        this.models.nanodet,
        this.models.faceres,
      ] = await Promise.all([
        this.models.face || (this.config.face.enabled ? facemesh.load(this.config) : null),
        this.models.age || ((this.config.face.enabled && this.config.face.age.enabled) ? age.load(this.config) : null),
        this.models.gender || ((this.config.face.enabled && this.config.face.gender.enabled) ? gender.load(this.config) : null),
        this.models.emotion || ((this.config.face.enabled && this.config.face.emotion.enabled) ? emotion.load(this.config) : null),
        this.models.embedding || ((this.config.face.enabled && this.config.face.embedding.enabled) ? embedding.load(this.config) : null),
        this.models.handpose || (this.config.hand.enabled ? <Promise<handpose.HandPose>>handpose.load(this.config) : null),
        this.models.posenet || (this.config.body.enabled && this.config.body.modelPath.includes('posenet') ? posenet.load(this.config) : null),
        this.models.blazepose || (this.config.body.enabled && this.config.body.modelPath.includes('blazepose') ? blazepose.load(this.config) : null),
        this.models.efficientpose || (this.config.body.enabled && this.config.body.modelPath.includes('efficientpose') ? efficientpose.load(this.config) : null),
        this.models.nanodet || (this.config.object.enabled ? nanodet.load(this.config) : null),
        this.models.faceres || ((this.config.face.enabled && this.config.face.description.enabled) ? faceres.load(this.config) : null),
      ]);
    } else {
      if (this.config.face.enabled && !this.models.face) this.models.face = await facemesh.load(this.config);
      if (this.config.face.enabled && this.config.face.age.enabled && !this.models.age) this.models.age = await age.load(this.config);
      if (this.config.face.enabled && this.config.face.gender.enabled && !this.models.gender) this.models.gender = await gender.load(this.config);
      if (this.config.face.enabled && this.config.face.emotion.enabled && !this.models.emotion) this.models.emotion = await emotion.load(this.config);
      if (this.config.face.enabled && this.config.face.embedding.enabled && !this.models.embedding) this.models.embedding = await embedding.load(this.config);
      if (this.config.hand.enabled && !this.models.handpose) this.models.handpose = await handpose.load(this.config);
      if (this.config.body.enabled && !this.models.posenet && this.config.body.modelPath.includes('posenet')) this.models.posenet = await posenet.load(this.config);
      if (this.config.body.enabled && !this.models.blazepose && this.config.body.modelPath.includes('blazepose')) this.models.blazepose = await blazepose.load(this.config);
      if (this.config.body.enabled && !this.models.efficientpose && this.config.body.modelPath.includes('efficientpose')) this.models.efficientpose = await efficientpose.load(this.config);
      if (this.config.object.enabled && !this.models.nanodet) this.models.nanodet = await nanodet.load(this.config);
      if (this.config.face.enabled && this.config.face.description.enabled && !this.models.faceres) this.models.faceres = await faceres.load(this.config);
    }

    if (this.#firstRun) {
      if (this.config.debug) log('tf engine state:', this.tf.engine().state.numBytes, 'bytes', this.tf.engine().state.numTensors, 'tensors');
      this.#firstRun = false;
    }

    const current = Math.trunc(now() - timeStamp);
    if (current > (this.perf.load || 0)) this.perf.load = current;
  }

  // check if backend needs initialization if it changed
  /** @hidden */
  #checkBackend = async (force = false) => {
    if (this.config.backend && (this.config.backend !== '') && force || (this.tf.getBackend() !== this.config.backend)) {
      const timeStamp = now();
      this.state = 'backend';
      /* force backend reload
      if (this.config.backend in tf.engine().registry) {
        const backendFactory = tf.findBackendFactory(this.config.backend);
        tf.removeBackend(this.config.backend);
        tf.registerBackend(this.config.backend, backendFactory);
      } else {
        log('Backend not registred:', this.config.backend);
      }
      */

      if (this.config.backend && this.config.backend !== '') {
        if (this.tf.ENV.flags.IS_BROWSER && this.config.backend === 'tensorflow') this.config.backend = 'webgl';
        if (this.tf.ENV.flags.IS_NODE && (this.config.backend === 'webgl' || this.config.backend === 'wasm')) this.config.backend = 'tensorflow';
        if (this.config.debug) log('setting backend:', this.config.backend);

        if (this.config.backend === 'wasm') {
          if (this.config.debug) log('wasm path:', this.config.wasmPath);
          this.tf.setWasmPaths(this.config.wasmPath);
          const simd = await this.tf.env().getAsync('WASM_HAS_SIMD_SUPPORT');
          const mt = await this.tf.env().getAsync('WASM_HAS_MULTITHREAD_SUPPORT');
          if (this.config.debug) log(`wasm execution: ${simd ? 'SIMD' : 'no SIMD'} ${mt ? 'multithreaded' : 'singlethreaded'}`);
          if (!simd) log('warning: wasm simd support is not enabled');
        }

        if (this.config.backend === 'humangl') backend.register();
        try {
          await this.tf.setBackend(this.config.backend);
        } catch (err) {
          log('error: cannot set backend:', this.config.backend, err);
        }
      }
      this.tf.enableProdMode();
      /* debug mode is really too mcuh
      this.tf.enableDebugMode();
      */
      this.tf.ENV.set('CHECK_COMPUTATION_FOR_ERRORS', false);
      this.tf.ENV.set('WEBGL_PACK_DEPTHWISECONV', true);
      if (this.tf.getBackend() === 'webgl') {
        if (this.config.deallocate) {
          log('changing webgl: WEBGL_DELETE_TEXTURE_THRESHOLD:', this.config.deallocate);
          this.tf.ENV.set('WEBGL_DELETE_TEXTURE_THRESHOLD', this.config.deallocate ? 0 : -1);
        }
        // this.tf.ENV.set('WEBGL_FORCE_F16_TEXTURES', true);
        // this.tf.ENV.set('WEBGL_PACK_DEPTHWISECONV', true);
        const gl = await this.tf.backend().getGPGPUContext().gl;
        if (this.config.debug) log(`gl version:${gl.getParameter(gl.VERSION)} renderer:${gl.getParameter(gl.RENDERER)}`);
      }
      await this.tf.ready();
      this.perf.backend = Math.trunc(now() - timeStamp);
    }
  }

  // main detect function
  async detect(input: Input, userConfig: Config | Object = {}): Promise<Result | Error> {
    // detection happens inside a promise
    return new Promise(async (resolve) => {
      this.state = 'config';
      let timeStamp;

      // update configuration
      this.config = mergeDeep(this.config, userConfig);

      // sanity checks
      this.state = 'check';
      const error = this.#sanity(input);
      if (error) {
        log(error, input);
        resolve({ error });
      }

      const timeStart = now();

      // configure backend
      await this.#checkBackend();

      // load models if enabled
      await this.load();

      if (this.config.scoped) this.tf.engine().startScope();
      this.analyze('Start Scope:');

      timeStamp = now();
      const process = image.process(input, this.config);
      if (!process || !process.tensor) {
        log('could not convert input to tensor');
        resolve({ error: 'could not convert input to tensor' });
        return;
      }
      this.perf.image = Math.trunc(now() - timeStamp);
      this.analyze('Get Image:');

      // prepare where to store model results
      let bodyRes;
      let handRes;
      let faceRes;
      let objectRes;
      let current;

      // run face detection followed by all models that rely on face bounding box: face mesh, age, gender, emotion
      if (this.config.async) {
        faceRes = this.config.face.enabled ? faceall.detectFace(this, process.tensor) : [];
        if (this.perf.face) delete this.perf.face;
      } else {
        this.state = 'run:face';
        timeStamp = now();
        faceRes = this.config.face.enabled ? await faceall.detectFace(this, process.tensor) : [];
        current = Math.trunc(now() - timeStamp);
        if (current > 0) this.perf.face = current;
      }

      // run body: can be posenet or blazepose
      this.analyze('Start Body:');
      if (this.config.async) {
        if (this.config.body.modelPath.includes('posenet')) bodyRes = this.config.body.enabled ? this.models.posenet?.estimatePoses(process.tensor, this.config) : [];
        else if (this.config.body.modelPath.includes('blazepose')) bodyRes = this.config.body.enabled ? blazepose.predict(process.tensor, this.config) : [];
        else if (this.config.body.modelPath.includes('efficientpose')) bodyRes = this.config.body.enabled ? efficientpose.predict(process.tensor, this.config) : [];
        if (this.perf.body) delete this.perf.body;
      } else {
        this.state = 'run:body';
        timeStamp = now();
        if (this.config.body.modelPath.includes('posenet')) bodyRes = this.config.body.enabled ? await this.models.posenet?.estimatePoses(process.tensor, this.config) : [];
        else if (this.config.body.modelPath.includes('blazepose')) bodyRes = this.config.body.enabled ? await blazepose.predict(process.tensor, this.config) : [];
        else if (this.config.body.modelPath.includes('efficientpose')) bodyRes = this.config.body.enabled ? await efficientpose.predict(process.tensor, this.config) : [];
        current = Math.trunc(now() - timeStamp);
        if (current > 0) this.perf.body = current;
      }
      this.analyze('End Body:');

      // run handpose
      this.analyze('Start Hand:');
      if (this.config.async) {
        handRes = this.config.hand.enabled ? this.models.handpose?.estimateHands(process.tensor, this.config) : [];
        if (this.perf.hand) delete this.perf.hand;
      } else {
        this.state = 'run:hand';
        timeStamp = now();
        handRes = this.config.hand.enabled ? await this.models.handpose?.estimateHands(process.tensor, this.config) : [];
        current = Math.trunc(now() - timeStamp);
        if (current > 0) this.perf.hand = current;
      }
      this.analyze('End Hand:');

      // run nanodet
      this.analyze('Start Object:');
      if (this.config.async) {
        objectRes = this.config.object.enabled ? nanodet.predict(process.tensor, this.config) : [];
        if (this.perf.object) delete this.perf.object;
      } else {
        this.state = 'run:object';
        timeStamp = now();
        objectRes = this.config.object.enabled ? await nanodet.predict(process.tensor, this.config) : [];
        current = Math.trunc(now() - timeStamp);
        if (current > 0) this.perf.object = current;
      }
      this.analyze('End Object:');

      // if async wait for results
      if (this.config.async) {
        [faceRes, bodyRes, handRes, objectRes] = await Promise.all([faceRes, bodyRes, handRes, objectRes]);
      }
      process.tensor.dispose();

      if (this.config.scoped) this.tf.engine().endScope();
      this.analyze('End Scope:');

      let gestureRes = [];
      if (this.config.gesture.enabled) {
        timeStamp = now();
        // @ts-ignore
        gestureRes = [...gesture.face(faceRes), ...gesture.body(bodyRes), ...gesture.hand(handRes), ...gesture.iris(faceRes)];
        if (!this.config.async) this.perf.gesture = Math.trunc(now() - timeStamp);
        else if (this.perf.gesture) delete this.perf.gesture;
      }

      this.perf.total = Math.trunc(now() - timeStart);
      this.state = 'idle';
      const result = {
        face: faceRes,
        body: bodyRes,
        hand: handRes,
        gesture: gestureRes,
        object: objectRes,
        performance: this.perf,
        canvas: process.canvas,
      };
      // log('Result:', result);
      resolve(result);
    });
  }

  /** @hidden */
  #warmupBitmap = async () => {
    const b64toBlob = (base64, type = 'application/octet-stream') => fetch(`data:${type};base64,${base64}`).then((res) => res.blob());
    let blob;
    let res;
    switch (this.config.warmup) {
      case 'face': blob = await b64toBlob(sample.face); break;
      case 'full': blob = await b64toBlob(sample.body); break;
      default: blob = null;
    }
    if (blob) {
      const bitmap = await createImageBitmap(blob);
      res = await this.detect(bitmap, this.config);
      bitmap.close();
    }
    return res;
  }

  /** @hidden */
  #warmupCanvas = async () => new Promise((resolve) => {
    let src;
    let size = 0;
    switch (this.config.warmup) {
      case 'face':
        size = 256;
        src = 'data:image/jpeg;base64,' + sample.face;
        break;
      case 'full':
      case 'body':
        size = 1200;
        src = 'data:image/jpeg;base64,' + sample.body;
        break;
      default:
        src = null;
    }
    // src = encodeURI('../assets/human-sample-upper.jpg');
    const img = new Image();
    img.onload = async () => {
      const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(size, size) : document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0);
      // const data = ctx?.getImageData(0, 0, canvas.height, canvas.width);
      const res = await this.detect(canvas, this.config);
      resolve(res);
    };
    if (src) img.src = src;
    else resolve(null);
  });

  /** @hidden */
  #warmupNode = async () => {
    const atob = (str) => Buffer.from(str, 'base64');
    const img = this.config.warmup === 'face' ? atob(sample.face) : atob(sample.body);
    // @ts-ignore
    const data = tf.node.decodeJpeg(img); // tf.node is only defined when compiling for nodejs
    const expanded = data.expandDims(0);
    this.tf.dispose(data);
    // log('Input:', expanded);
    const res = await this.detect(expanded, this.config);
    this.tf.dispose(expanded);
    return res;
  }

  async warmup(userConfig: Config | Object = {}): Promise<Result | { error }> {
    const t0 = now();
    if (userConfig) this.config = mergeDeep(this.config, userConfig);
    const save = this.config.videoOptimized;
    this.config.videoOptimized = false;
    let res;
    if (typeof createImageBitmap === 'function') res = await this.#warmupBitmap();
    else if (typeof Image !== 'undefined') res = await this.#warmupCanvas();
    else res = await this.#warmupNode();
    this.config.videoOptimized = save;
    const t1 = now();
    if (this.config.debug) log('Warmup', this.config.warmup, Math.round(t1 - t0), 'ms', res);
    return res;
  }
}

/**
 * Class Human is also available as default export
 */
export { Human as default };
