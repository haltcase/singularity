import EventEmitter from 'eventemitter2'
import Levers from 'levers'

import * as ipc from './ipc-bridge'
import { initBotDB, botDB as db } from 'common/components/db'
import bindMethods from './lib/bind-methods'

import bot from './bot'
import extensions from './extension-loader'
import registry, {
  loadCustomCommands,
  unregister,
  extendCore
} from './command-registry'

ipc.on('initialize', initialize)
ipc.on('disconnect', disconnect)

const settings = new Levers('app')
const twitch = new Levers('twitch')

const channel = {
  name: twitch.get('name'),
  botName: settings.get('bot.name')
}

const getModule = cmd => extensions.loadModule(registry[cmd].module)
const getRunner = cmd => getModule(cmd)[registry[cmd].handler]

async function getSubcommand (event) {
  const { command, args: [query] } = event
  const cased = query ? query.toLowerCase() : undefined
  if (!query || !await this.command.exists(command, cased)) {
    return [undefined, {}]
  }

  const subArgs = event.args.slice(1)
  const subArgString = subArgs.join(' ')

  return [cased, {
    subcommand: cased,
    subArgs,
    subArgString
  }]
}

function createResponder ({ sender, whispered }) {
  const responder = whispered
    ? this.whisper.bind(null, sender)
    : this.say.bind(null, sender)

  return message => responder(message)
}

class Core extends EventEmitter {
  constructor () {
    // initialize the emitter
    super({
      wildcard: true,
      delimiter: ':',
      newListener: false,
      maxListeners: 30
    })

    Object.assign(this, {
      channel,
      command: {
        getModule,
        getRunner
      }
    })

    // forward events from the app emitter
    ipc.forward(this)
  }

  /**
   * Override `EventEmitter#on` to add the ability to
   * prevent adding the same exact listener twice.
   *
   * @param channel
   * @param fn
   * @param single
   */
  on (channel, fn, single = true) {
    if (single) this.off(channel, fn)
    super.on(channel, fn)
  }

  async runCommand (event) {
    const { command, sender, groupID } = event
    const [subcommand, subEvent] = await this::getSubcommand(event)
    if (subcommand) Object.assign(event, subEvent)

    const [
      pointsEnabled,
      cooldownsEnabled,
      commandExists,
      commandIsEnabled,
      commandPermission
    ] = await Promise.all([
      this.db.getExtConfig('points', 'enabled', true),
      this.db.getExtConfig('cooldown', 'enabled', true),
      this.command.exists(command),
      this.command.isEnabled(command, subcommand),
      this.command.getPermLevel(command, subcommand)
    ])

    // Check if the specified command is registered
    if (!commandExists) {
      this.log.event('core', `'${command}' is not a registered command`)
      return
    }

    // Check if the specified (sub)command is enabled
    if (!commandIsEnabled) {
      this.log.event(
        'core',
        `'${command}${subcommand ? ' ' + subcommand : ''}' is installed but is not enabled`
      )
      return
    }

    // Check if the specified (sub)command is on cooldown
    if (cooldownsEnabled) {
      const cooldownActive = await this.command.isOnCooldown(command, sender, subcommand)
      if (cooldownActive) {
        this.log.event('core',
          `'${command}' is on cooldown for ${sender} (${cooldownActive} seconds)`
        )
        this.whisper(
          event.sender,
          `You need to wait ${cooldownActive} seconds to use !${command} again.`
        )
        return
      }
    }

    // Check that the user has sufficient privileges to use the (sub)command
    if (groupID > commandPermission) {
      this.log.event('core',
        `${sender} does not have sufficient permissions to use !${command}`
      )
      this.whisper(sender, `You don't have what it takes to use !${command}.`)
      return
    }

    let charge = 0
    // Check that the user has enough points to use the (sub)command
    if (pointsEnabled) {
      const [canAfford, userPoints, commandPrice] = await this.user.canAffordCommand(
        sender, command, subcommand
      )

      if (!canAfford) {
        this.log('core', `${sender} does not have enough points to use !${command}.`)
        this.whisper(
          sender,
          `You don't have enough points to use !${command}. ` +
          `» costs ${commandPrice}, you have ${userPoints}`
        )

        return
      }

      charge = commandPrice
    }

    // Add the `respond` helper function to the event object
    event.respond = this::createResponder(event)

    // Finally, run the (sub)command
    if (await this.command.isCustom(command)) {
      const response = await db.get('commands', 'response', {
        name: command, module: 'custom'
      })

      this.say(event.sender, await this.params(event, response))
    } else {
      try {
        getRunner(command)(event, this)
      } catch (e) {
        this.log.error('core', e.message)
        return
      }
    }

    if (cooldownsEnabled) this.command.startCooldown(command, sender, subcommand)
    if (pointsEnabled && charge) this.points.sub(sender, charge)

    // Fire the command event over the emitter
    this.emit(`command:${command}${subcommand ? ':' + subcommand : ''}`, event)
  }
}

export async function initialize () {
  if (!settings.get('bot.name') || !settings.get('bot.auth')) {
    return ipc.log.bot('Bot setup is not complete.')
  }

  ipc.log.bot('Initializing bot...')

  const core = new Core()
  global.$ = core
  bot.connect()

  initBotDB()
  await loadTables()
  await loadHelpers()
  bindMethods(core, {
    registry, extensions, channel
  })
  extendCore(core)
  extensions.registerAll()

  ipc.log.bot('Bot ready.')
  core.emit('ready', core)
  ipc.emit('bot:loaded')

  loadCustomCommands()
}

export function disconnect () {
  ipc.log.bot('Deactivating bot...')
  bot.disconnect()
  unregister(true)
  ipc.log.bot('Deactivated bot.')
  ipc.emit('bot:unloaded')
}

/*
export function reconfigure (name, auth) {
  updateAuth(name, auth)
}
*/

async function loadTables () {
  await db.addTable('settings', [
    { name: 'key', primary: true },
    'value', 'info'
  ])

  await db.initSettings()

  await Promise.all([
    db.addTable('extension_settings', [
      'extension', 'key', 'value', 'info'
    ], { compositeKey: ['extension', 'key'] }),

    db.addTable('users', [
      { name: 'name', unique: 'inline' },
      { name: 'permission', type: 'integer' },
      { name: 'mod', defaultTo: 'false' },
      { name: 'following', defaultTo: 'false' },
      { name: 'seen', type: 'integer', defaultTo: 0 },
      { name: 'points', type: 'integer', defaultTo: 0 },
      { name: 'time', type: 'integer', defaultTo: 0 },
      { name: 'rank', type: 'integer', defaultTo: 1 }
    ]),

    db.addTable('commands', [
      { name: 'name', unique: 'inline' },
      { name: 'cooldown', type: 'integer', defaultTo: 30 },
      { name: 'permission', type: 'integer', defaultTo: 5 },
      { name: 'status', defaultTo: 'false' },
      { name: 'price', type: 'integer', defaultTo: 0 },
      'module', 'response'
    ]),

    db.addTable('subcommands', [
      'name',
      { name: 'cooldown', type: 'integer', defaultTo: 30 },
      { name: 'permission', type: 'integer', defaultTo: 5 },
      { name: 'status', defaultTo: 'false' },
      { name: 'price', type: 'integer', defaultTo: 0 },
      'module',
      'parent'
    ], { compositeKey: ['name', 'module'] })
  ])
}

async function loadHelpers () {
  require('./helpers')
}