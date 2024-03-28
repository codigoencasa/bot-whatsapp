const { generateRef } = require('../../utils/hash')

const eventContact = () => {
    return generateRef('_event_contact_')
}

const REGEX_EVENT_CONTACT = /^_event_contact__[\w\d]{8}-(?:[\w\d]{4}-){3}[\w\d]{12}$/

module.exports = { eventContact, REGEX_EVENT_CONTACT }
