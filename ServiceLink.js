.pragma library
// Where widgets find the service under any bar. A replacement bar's shell
// answers serviceFor() with null, so the service also registers here: a
// .pragma library script has one copy per QML engine, shared by Service.qml
// and every monitor's widget. Widgets subscribe to follow a service that
// loads later, reloads or goes away.

var service = null
var listeners = []

function current() {
  return service
}

function register(next) {
  service = next
  notify()
}

// A reloaded service may already have replaced this one.
function unregister(old) {
  if (service !== old) return
  service = null
  notify()
}

function subscribe(listener) {
  listeners.push(listener)
}

function unsubscribe(listener) {
  var i = listeners.indexOf(listener)
  if (i !== -1) listeners.splice(i, 1)
}

function notify() {
  for (var i = 0; i < listeners.length; i++) listeners[i](service)
}
