module.exports.tryParseJSON = function (json, reviver) {
  try {
    return JSON.parse(json, reviver)
  } catch (error) {
    console.log('JSON', json)
    return error
  }
}
