import path from 'path'
import { promises as fs } from 'fs'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import { ffmpeg } from 'eloquent-ffmpeg'
import { path as ffprobePath } from 'ffprobe-static'
import { WebSocketServer } from 'ws'
import strftime from 'strftime'

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
const config = yaml.load(await fs.readFile(path.resolve(args.config || './config.yml'), 'utf8')).server
console.log(config)

const filesErrored = []
const filesProcessing = []
const workers = {}

const scanner = {
  scanning: false,
  startedAt: 0
}

// Load files to ignore
console.log(`Loading: ${config.filesIgnored}`)
const filesIgnored = await fs.readFile(config.filesIgnored, 'utf8')
  .then((d) => { return JSON.parse(d || []) }) // If file is empty return an empty array
  .catch(() => { return [] }) // If file does not exist return an empty array
console.log(`Finished Loading: ${config.filesIgnored}`)

// Load files done
console.log(`Loading: ${config.filesDone}`)
const filesDone = await fs.readFile(config.filesDone, 'utf8')
  .then(async (d) => {
    console.log('Verifying that files still exist.')
    // If file is empty return an empty array
    const files = JSON.parse(d || [])
    const fileCount = files.length

    // Check if all the files still exist
    for (const file of files) {
      // If fs.lstat fails then the file does not exist or is not accessible
      await fs.lstat(file)
        .catch(() => {
          files.splice(files.indexOf(file), 1)
        })
    }

    // Update files-list.json if files were removed
    if (files.length !== fileCount) {
      await fs.writeFile(config.filesDone, JSON.stringify(files, null, '\t'))
    }

    console.log('Finished verifying that files still exist.')
    return files.sort()
  })
  .catch(() => { return [] }) // If file does not exist return an empty array
console.log(`Finished Loading: ${config.filesDone}`)

// Load files to process
console.log(`Loading: ${config.filesPending}`)
const filesPending = await fs.readFile(config.filesPending, 'utf8')
  .then(async (d) => {
    console.log('Verifying that files still exist.')
    // If file is empty return an empty array
    const files = JSON.parse(d || [])
    const fileCount = files.length

    // Check if all the files still exist
    for (const file of files) {
      // If fs.lstat fails then the file does not exist or is not accessible
      await fs.lstat(file)
        .catch(() => {
          files.splice(files.indexOf(file), 1)
        })
    }

    // Update files-list.json if files were removed
    if (files.length !== fileCount) {
      await fs.writeFile(config.filesPending, JSON.stringify(files, null, '\t'))
    }

    console.log('Finished verifying that files still exist.')
    return files.sort()
  })
  .catch(() => { return [] }) // If file does not exist return an empty array
console.log(`Finished Loading: ${config.filesPending}`)

// Blessed GUI
const screen = blessed.screen()
const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen })

const log = grid.set(6, 6, 6, 6, contrib.log, {
  fg: 'green',
  selectedFg: 'green',
  label: 'Server Log'
})

const queueTable = grid.set(0, 0, 6, 6, contrib.table, {
  keys: true,
  fg: 'green',
  label: 'Files Queued',
  columnSpacing: 1,
  columnWidth: [100, 10, 10]
})

const erroredTable = grid.set(6, 0, 3, 6, contrib.table, {
  keys: true,
  fg: 'green',
  label: 'Files Errored',
  columnSpacing: 1,
  columnWidth: [100, 10, 10]
})

const doneTable = grid.set(9, 0, 3, 6, contrib.table, {
  keys: true,
  fg: 'green',
  label: 'Files Done',
  columnSpacing: 1,
  columnWidth: [100, 10, 10]
})

const workerTable = grid.set(0, 6, 3, 6, contrib.table, {
  keys: true,
  fg: 'green',
  label: 'Workers',
  columnSpacing: 1,
  columnWidth: [18, 59, 5, 7, 13]
})

const idleTable = grid.set(3, 6, 3, 6, contrib.table, {
  keys: true,
  fg: 'green',
  label: 'Idle Workers',
  columnSpacing: 1,
  columnWidth: [18, 59, 5, 7, 13]
})

queueTable.focus()

// Loop for updating values in tables
setInterval(async () => {
  queueTable.setData({ headers: ['Filename'], data: filesPending.map(d => [path.basename(d)]) })
  erroredTable.setData({ headers: ['Filename'], data: filesErrored.map(d => [path.basename(d)]) })
  doneTable.setData({ headers: ['Filename'], data: filesDone.map(d => [path.basename(d)]) })

  try {
    workerTable.setData({
      headers: ['Worker', 'Filename', 'FPS', '%', 'Timemark'],
      data: Object.keys(workers)
        .map(worker => workers[worker])
        .filter(worker => worker.task !== 'idle')
        .sort((a, b) => parseFloat(a.task.file.progress) > parseFloat(b.task.file.progress) ? -1 : 1)
        .map(worker => {
          const file = worker.task.file

          return [
            worker.hostname ? worker.hostname.slice(0, 16) : '',
            file.name ? file.name.slice(0, 58) : '',
            file.fps,
            file.progress,
            file.timemark || ''
          ]
        })
    })
  } catch (err) {
    // console.log(workers)
    fs.appendFile('error.log', logger(`Error: (workerTable) ${err.message}, ${JSON.stringify(workers)}`), 'utf8')
      .catch((e) => { throw e })
  }

  idleTable.setData({
    headers: ['Worker'],
    data: Object.keys(workers)
      .map(worker => workers[worker])
      .filter(worker => worker.task === 'idle')
      .sort((a, b) => a.hostname > b.hostname ? 1 : -1)
      .map(worker => [worker.hostname])
  })
}, 1000)

// Loop for rendering updates
setInterval(() => { screen.render() }, 500)

screen.key(['tab'], (ch, key) => {
  screen.focusNext()
})

screen.key(['escape', 'q', 'C-c'], function (ch, key) {
  return process.exit(0)
})

screen.key(['s'], function (ch, key) {
  if (scanner.scanning === false)
      logger(`Manualy starting scan`)
      scanner.startedAt = 0
})

const videoInfo = async (file) => {
  const input = ffmpeg().input(file)
  .args('-hwaccel', 'auto') // uses hardware acceleration for decoding if available

  const info = await input.probe({ ffprobePath })
    .catch(err => { throw err })

  const stream = info.unwrap().streams.filter(stream => stream.codec_type === 'video').shift()

  if (stream === 'undefined') {
    throw new Error('No valid video stream')
  }

  return({ file: file, codec: stream.codec_name, height: stream.height, width: stream.width })
}

const readDirRecursive = async (root) => {
  return await fs.readdir(root)
    .then(async (files) => {
      for (const file of files) {
        const filePath = path.join(root, file).replace(/\\/g, '/')
        const stat = await fs.lstat(filePath)
          .catch(() => {
            files.splice(files.indexOf(file), 1)
          })

        // If stat is undefined go to next file
        if (stat === undefined) {
          continue
        }

        if (stat.isDirectory()) {
          await readDirRecursive(filePath)
        }

        if (stat.isFile()) {
          const group = file.slice(file.lastIndexOf('-'), file.lastIndexOf('.')).toLowerCase()

          if (config.validExtensions.includes(path.extname(file)) &&
            !config.excludedGroups.map((group) => group.toLowerCase()).includes(group) &&
            !filesPending.includes(filePath) && // Skip files that are already in queue
            !filesProcessing.includes(filePath) && // Skip files that are in progress
            !filesDone.includes(filePath) && // Skip files that have finished in this session
            !filesErrored.includes(filePath) && // Skip files that have errored in this session
            !filesIgnored.includes(file)) {
            const video = await videoInfo(filePath)
              .catch((err) => logger(`Error: (VideoInfo) ${err}`))

            if ((video.width >= 1280 || video.height >= 720) && !config.excludedCodecs.includes(video.codec)) {
              // Add file to list
              logger(`Adding: ${file}`)

              // Add file to array
              filesPending.push(filePath)
              // Sort array
              filesPending.sort()
              // Update file to array
              await fs.writeFile(config.filesPending, JSON.stringify(filesPending, null, '\t'))
            } else {
              // Add file to ignore list
              logger(`Ignoring: ${file}`)

              // Add file to array
              filesIgnored.push(file)
              // Update files ignored
              await fs.writeFile(config.filesIgnored, JSON.stringify(filesIgnored, null, '\t'))
            }
          }
        }
      }

      return filesPending
    })
    .catch((err) => { throw err })
}

// Scanner loop
setInterval(() => {
  if (scanner.scanning === false) {
    const nextScanIn = (((scanner.startedAt + config.scanInterval * 1000) - Date.now()) / 1000).toFixed(0)

    if (nextScanIn % 300 < 10 && nextScanIn > 0) {
      logger(`Next scan starts in ${nextScanIn} seconds`)
    }
  } else {
    logger(`Scan in progress for ${((Date.now() - scanner.startedAt) / 1000).toFixed(0)} seconds`)
  }

  if (scanner.scanning === false && (scanner.startedAt + config.scanInterval * 1000) <= Date.now()) {
    scanner.scanning = true
    scanner.startedAt = Date.now()

    logger('Starting Scan')
    readDirRecursive(config.sourceDirectory)
      .then((d) => {
        scanner.scanning = false
      })
      .catch((err) => { throw err })
  }
}, 10000)

function logger (msg) {
  const message = `[${strftime('%H:%M:%S')}]: ${msg}`

  log.log(message)
  return message
}

const wss = new WebSocketServer({ port: config.websocket.listeningPort })

wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.remoteAddress = req.socket.remoteAddress
  logger(`Client ${req.socket.remoteAddress} connected!`)

  const heartbeat = () => {
    ws.isAlive = true
  }

  ws.on('pong', heartbeat)

  ws.on('close', () => {
    delete workers[ws.hostname]
  })

  ws.on('message', async (message) => {
    const d = JSON.parse(message)

    for (const key of Object.keys(d)) {
      switch (key) {
        case 'status':
          if (!ws.hostname) {
            ws.hostname = d.status.hostname
          }

          workers[ws.hostname] = d.status

          if (d.status.task === 'idle') {
            if (filesPending.length > 0) {
              const file = filesPending.shift() // Remove file from queue
              filesProcessing.push(file) // Add file to processing
              const task = {
                task: {
                  file: {
                    name: path.basename(file)
                      .replace(/\.[^/.]+$/, '')
                      .replace(/ /g, '.')
                      .replace(file.slice(file.lastIndexOf('-'), file.lastIndexOf('.')), '') + '-Fi.mkv',
                    path: file,
                    fps: 0,
                    progress: 0,
                    size: 0
                  }
                }
              }

              logger(`Tasking ${ws.hostname}:`, task)
              // const elapsed = hrtime(timer)
              // console.log(`${filesPending.length} Files to be proccessed, Elapsed Time: ${Math.round(100 * (elapsed[0] * 1000000000 + elapsed[1]) / 1000000000) / 100} seconds`)

              // Update filesPending file
              await fs.writeFile(config.filesPending, JSON.stringify(filesPending, null, '\t'))

              ws.send(JSON.stringify(task))
            }
          } else {
            const file = d.status.task.file.path || null
            
            //Check if file is in filesProcessing and add it if missing
            if (file && !filesProcessing.includes(file)) {
              filesProcessing.push(file)
            }
          }

          break
        case 'error':
          // Add file to array
          filesErrored.push(d.error.file)
          // Update files ignored
          await fs.writeFile(config.filesErrored, JSON.stringify(filesErrored, null, '\t'))
          filesProcessing.slice(filesProcessing.indexOf(d.error.file), 1) // Remove file from processing

          logger(`Error: (Worker) ${d.error.message}`)
          break
        case 'done':
          filesDone.push(d.done.file)
          await fs.writeFile(config.filesDone, JSON.stringify(filesDone, null, '\t'))
          filesProcessing.slice(filesProcessing.indexOf(d.done.file), 1) // Remove file from processing

          logger(`${ws.hostname} finished ${d.done.file}`)
          break
        default:
          logger(`Message: ${message}`)
      }
    }
  })
})

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      logger(`Closing ${ws.remoteAddress}`)
      return ws.terminate()
    }

    const noop = () => {}

    ws.isAlive = false
    ws.ping(noop)
  })
}, config.websocket.heartbeat)

wss.on('close', () => {
  // The websocket server closed
  logger('WebSocket server closed')
  clearInterval(interval)
  process.exit(1)
})
