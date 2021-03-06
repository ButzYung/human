import { log } from '../helpers';
import * as tf from '../../dist/tfjs.esm.js';
import * as profile from '../profile';
import { labels } from './labels';

let model;
let last: Array<{}> = [];
let skipped = Number.MAX_SAFE_INTEGER;

const scaleBox = 2.5; // increase box size

export async function load(config) {
  if (!model) {
    model = await tf.loadGraphModel(config.object.modelPath);
    // @ts-ignore
    model.inputSize = parseInt(Object.values(model.modelSignature['inputs'])[0].tensorShape.dim[2].size);
    if (config.debug) log(`load model: ${config.object.modelPath.match(/\/(.*)\./)[1]}`);
  }
  return model;
}

async function process(res, inputSize, outputShape, config) {
  let id = 0;
  let results: Array<{ score: number, strideSize: number, class: number, label: string, center: number[], centerRaw: number[], box: number[], boxRaw: number[] }> = [];
  for (const strideSize of [1, 2, 4]) { // try each stride size as it detects large/medium/small objects
    // find scores, boxes, classes
    tf.tidy(() => { // wrap in tidy to automatically deallocate temp tensors
      const baseSize = strideSize * 13; // 13x13=169, 26x26=676, 52x52=2704
      // find boxes and scores output depending on stride
      const scoresT = res.find((a) => (a.shape[1] === (baseSize ** 2) && a.shape[2] === labels.length))?.squeeze();
      const featuresT = res.find((a) => (a.shape[1] === (baseSize ** 2) && a.shape[2] < labels.length))?.squeeze();
      const boxesMax = featuresT.reshape([-1, 4, featuresT.shape[1] / 4]); // reshape [output] to [4, output / 4] where number is number of different features inside each stride
      const boxIdx = boxesMax.argMax(2).arraySync(); // what we need is indexes of features with highest scores, not values itself
      const scores = scoresT.arraySync(); // optionally use exponential scores or just as-is
      for (let i = 0; i < scoresT.shape[0]; i++) { // total strides (x * y matrix)
        for (let j = 0; j < scoresT.shape[1]; j++) { // one score for each class
          const score = scores[i][j]; // get score for current position
          if (score > config.object.minConfidence && j !== 61) {
            const cx = (0.5 + Math.trunc(i % baseSize)) / baseSize; // center.x normalized to range 0..1
            const cy = (0.5 + Math.trunc(i / baseSize)) / baseSize; // center.y normalized to range 0..1
            const boxOffset = boxIdx[i].map((a) => a * (baseSize / strideSize / inputSize)); // just grab indexes of features with highest scores
            const [x, y] = [
              cx - (scaleBox / strideSize * boxOffset[0]),
              cy - (scaleBox / strideSize * boxOffset[1]),
            ];
            const [w, h] = [
              cx + (scaleBox / strideSize * boxOffset[2]) - x,
              cy + (scaleBox / strideSize * boxOffset[3]) - y,
            ];
            let boxRaw = [x, y, w, h]; // results normalized to range 0..1
            boxRaw = boxRaw.map((a) => Math.max(0, Math.min(a, 1))); // fix out-of-bounds coords
            const box = [ // results normalized to input image pixels
              boxRaw[0] * outputShape[0],
              boxRaw[1] * outputShape[1],
              boxRaw[2] * outputShape[0],
              boxRaw[3] * outputShape[1],
            ];
            const result = {
              id: id++,
              strideSize,
              score,
              class: j + 1,
              label: labels[j].label,
              center: [Math.trunc(outputShape[0] * cx), Math.trunc(outputShape[1] * cy)],
              centerRaw: [cx, cy],
              box: box.map((a) => Math.trunc(a)),
              boxRaw,
            };
            results.push(result);
          }
        }
      }
    });
  }
  // deallocate tensors
  res.forEach((t) => tf.dispose(t));

  // normally nms is run on raw results, but since boxes need to be calculated this way we skip calulcation of
  // unnecessary boxes and run nms only on good candidates (basically it just does IOU analysis as scores are already filtered)
  const nmsBoxes = results.map((a) => a.boxRaw);
  const nmsScores = results.map((a) => a.score);
  let nmsIdx: any[] = [];
  if (nmsBoxes && nmsBoxes.length > 0) {
    const nms = await tf.image.nonMaxSuppressionAsync(nmsBoxes, nmsScores, config.object.maxResults, config.object.iouThreshold, config.object.minConfidence);
    nmsIdx = nms.dataSync();
    tf.dispose(nms);
  }

  // filter & sort results
  results = results
    .filter((a, idx) => nmsIdx.includes(idx))
    .sort((a, b) => (b.score - a.score));

  return results;
}

export async function predict(image, config) {
  if (!model) return null;
  // console.log(skipped, config.object.skipFrames, config.videoOptimized, ((skipped < config.object.skipFrames) && config.videoOptimized && (last.length > 0)));
  if ((skipped < config.object.skipFrames) && config.videoOptimized && (last.length > 0)) {
    skipped++;
    return last;
  }
  if (config.videoOptimized) skipped = 0;
  else skipped = Number.MAX_SAFE_INTEGER;
  return new Promise(async (resolve) => {
    const outputSize = [image.shape[2], image.shape[1]];
    const resize = tf.image.resizeBilinear(image, [model.inputSize, model.inputSize], false);
    const norm = resize.div(255);
    const transpose = norm.transpose([0, 3, 1, 2]);
    norm.dispose();
    resize.dispose();

    let objectT;
    if (!config.profile) {
      if (config.object.enabled) objectT = await model.executeAsync(transpose);
    } else {
      const profileObject = config.object.enabled ? await tf.profile(() => model.executeAsync(transpose)) : {};
      objectT = profileObject.result;
      profile.run('object', profileObject);
    }
    transpose.dispose();

    const obj = await process(objectT, model.inputSize, outputSize, config);
    last = obj;
    resolve(obj);
  });
}
