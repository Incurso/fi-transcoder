import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import WebSocket from 'ws'
import si from 'systeminformation'
import ffmpegPath from 'ffmpeg-static'
import { path as ffprobePath } from 'ffprobe-static'
import { ffmpeg } from 'eloquent-ffmpeg'

const args = parseArgs(process.argv.slice(2))

// Display help and exit
if (args.help) {
  console.log(`Usage: node ${path.basename(process.argv.slice(1,2).toString())} [OPTION]\n`)
  console.log(`${'--config <inputfilename>'.padEnd(32)} Load YAML config file.`)
  console.log(`${'--help'.padEnd(32)} Displays this help and exit.`)
  console.log('')
  process.exit(0)
}

// Load config file
const config = yaml.load(await fs.readFile(path.resolve(args.config || './config.yml'), 'utf8')).client
console.log(config)

async function moveFile(oldPath, newPath) {
  // 1. Create the destination directory
  // Set the `recursive` option to `true` to create all the subdirectories
  await fs.mkdir(path.dirname(newPath), { recursive: true });
  try {
    // 2. Rename the file (move it to the new directory)
    await fs.rename(oldPath, newPath);
  } catch (error) {
    if (error.code === 'EXDEV') {
      // 3. Copy the file as a fallback
      await fs.copyFile(oldPath, newPath);
      // Remove the old file
      await fs.unlink(oldPath);
    } else {
      // Throw any other error
      throw error;
    }
  }
}

const worker = {
  hostname: os.hostname(),
  cpu: Math.round(100 * (await si.currentLoad()).currentload) / 100,
  mem: Math.round(100 * (100 * (await si.mem()).used / (await si.mem()).total)) / 100,
  task: 'idle'
}

const encodeVideo = async (src, dst, preset) => {
  const cmd = ffmpeg()

  const input = cmd.input(src)
    .args('-hwaccel', 'auto') // uses hardware acceleration for decoding if available

  const output = cmd.output(dst)
    .args('-map', '0')
    .args('-map', '-v')
    .args('-map', 'V')
    // Video
    //.args('-c:v', 'hevc_nvenc') // uses HEVC/h265 GPU hardware encoder
    .args('-c:v', 'libx265')
    .args('-x265-params', 'crf=23')
    // Audio
    .args('-c:a', 'libvorbis') // use Vorbis
    .args('-aq', '4') // set quality to 4
    // Subtitle
    .args('-c:s', 'copy') // copy subtitles

  const info = await input.probe({ ffprobePath });
  console.log(info)

  // Define errorMessage as false so that we can see when we have an error
  let errorMessage = false
  const proc = await cmd
    .spawn({
      ffmpegPath,
      logger: {
        error: async (message) => {
          // Set errorMessage if we get an error
          errorMessage = message;
        }
      }
    })

  for await (const { bytes, frames, fps, speed, time } of proc.progress()) {
    const task = worker.task

    task.file.frames = frames
    task.file.fps = Math.round(fps)
    task.file.progress = parseFloat(time / info.duration * 100).toFixed(2)
    task.file.timemark = new Date(time).toISOString().substr(11, 8)
    task.file.size = bytes

    worker.task = task
    
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
    process.stdout.write(`${path.basename(src)}: speed=${speed}x fps=${fps} ${task.file.progress}% time=${task.file.timemark}`)

    // If we get an error message, throw the error
    if (errorMessage !== false) {
      await proc.abort()
      throw new Error(errorMessage)
    }
  }

  await proc.complete()
  worker.task = 'idle'
  console.log(`\nFinished transcoding ${src}`)
}

const connect = () => {
  let ws = new WebSocket(`ws://${config.websocket.host}:${config.websocket.port}`)
  let pingTimeout = null

  const heartbeat = async () => {
      clearTimeout(pingTimeout)

    worker.cpu = Math.round(100 * (await si.currentLoad()).currentload) / 100
    worker.mem = Math.round(100 * (100 * (await si.mem()).used / (await si.mem()).total)) / 100

    ws.send(JSON.stringify({ status: worker }))

    pingTimeout = setTimeout(() => {
      ws.close()
    }, config.websocket.heartbeat + 1000)
  }

  ws.on('open', () => {
    console.log(`\nConnected to ${config.websocket.host}.`)
    heartbeat()
  })

  ws.on('ping', heartbeat)

  ws.on('close', () => {
    console.log('\nSocket is closed. Reconnect will be attempted in 1 second.')
    setTimeout(() => connect(), 1000)
  })

  ws.on('error', (err) => {
    console.error(`\nSocket encountered error: ${err.message}, Closing socket.`)
  })

  ws.on('message', async (message) => {
    const d = JSON.parse(message)

    if (d.task && worker.task === 'idle') {
      worker.task = d.task
      const srcFile = d.task.file.path
      const dstFile = path.join(config.destinationDirectory, d.task.file.name)

      await encodeVideo(srcFile, dstFile, 'x265')
        .then(async () => {
          worker.task = 'idle'

          // Move file to complete
          await moveFile(dstFile, path.join(config.destinationDirectory, 'complete', path.basename(dstFile)))
            .then(() => {
              console.log(`Moved ${dstFile} to completed.`)
            })
            .catch((err) => {
              console.log(err)
            })

          // Notify server that file is done and that worker is idle
          await ws.send(JSON.stringify({
            done: {
              file: srcFile
            },
            status: worker
          }))

          // Notify server that worker is idle
          //await ws.send(JSON.stringify({ status: worker }))
        })
        .catch((err) => {
          console.error(err.message)
          worker.task = 'idle'

          // Remove failed file
          if (config.deleteFailed) {
            fs.unlink(dstFile)
              .catch((err) => console.log(err))
          }

          ws.send(JSON.stringify({
            error: {
              message: err.message,
              file: srcFile
            }
          }))
        })
    }
  })
}

connect()
