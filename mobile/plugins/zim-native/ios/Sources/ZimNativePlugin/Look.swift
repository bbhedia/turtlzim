// What a server shows as its certificate, found out by a handshake and nothing more: a connection that takes whatever the server shows, reads the first certificate it sent, and is closed as soon
// as the handshake is over, with nothing written to it. So nothing is sent to a server that the person has not trusted yet. (This is for looking: it is given to no connection that anything is
// sent on; a request goes through Exchange, which takes the system's trust or one certificate.)
import Foundation
import Network
import Security
import ZimNativeRules

enum Look {
    /// The first certificate that the server at this address sent (DER), or why it can't be had.
    static func at(host: String, port: Int, done: @escaping (Result<Data, Failure>) -> Void) {
        guard let number = NWEndpoint.Port(rawValue: UInt16(port)) else {
            done(.failure(Failure(message: "That is not an address.", code: nil)))
            return
        }
        let queue = DispatchQueue(label: "zim-native-look")
        let lock = NSLock()
        var finished = false
        var shown: Data?
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let reference = sec_trust_copy_ref(trust).takeRetainedValue()
            if let first = (SecTrustCopyCertificateChain(reference) as? [SecCertificate])?.first {
                lock.lock()
                shown = SecCertificateCopyData(first) as Data
                lock.unlock()
            }
            complete(true)
        }, queue)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: number, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
        func finish(_ result: Result<Data, Failure>) {
            lock.lock()
            let already = finished
            finished = true
            lock.unlock()
            if already { return }
            connection.cancel()
            done(result)
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                lock.lock()
                let certificate = shown
                lock.unlock()
                if let certificate = certificate {
                    finish(.success(certificate))
                } else {
                    finish(.failure(Failure(message: "The server showed no certificate.", code: nil)))
                }
            case .failed(let error), .waiting(let error):
                finish(.failure(Failure(message: describe(error), code: nil)))
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 15) { finish(.failure(Failure(message: "The server took too long to answer.", code: nil))) }
    }

    private static func describe(_ error: NWError) -> String {
        switch error {
        case .dns:
            return "The server's name was not found: check the address, and that this device is online."
        case .tls:
            return "A secure connection to the server could not be set up."
        default:
            return "The server did not answer: check the address, and that this device is online."
        }
    }
}
