//! Where a device's push address may point, and which network address it may be sent to.
//!
//! A subscription is an address a person gives the server, and the server then calls it. Left open, that would let a
//! person point the sender at the server's own network (a metadata address, a database, an admin port). So:
//!
//! - the address is `https`, at most 512 characters, carries no credentials, and its host is one of the known push
//!   services or one the operator listed (`BUZZ_WEB_PUSH_EXTRA_HOSTS`, for a local stand-in);
//! - the host is resolved when the message is sent, an address that is private, loopback, link-local or otherwise not
//!   public is refused unless the host is on the operator's list, and the connection is made to **the address that
//!   passed** (the client is given it), so a name that changes its answer cannot pass the check and connect elsewhere.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::{Host, Url};

/// The longest endpoint address kept.
pub const ENDPOINT_MAX: usize = 512;

/// Push services whose subscription addresses are accepted: an exact host, or `*.suffix` for any host under it.
const KNOWN_HOSTS: [&str; 4] = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "*.push.apple.com",
    "*.notify.windows.com",
];

/// Why a subscription address was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// It is longer than [`ENDPOINT_MAX`] or does not parse as an address.
    Malformed,
    /// It is not `https` (an operator-listed host may be plain `http`, for a local stand-in).
    NotHttps,
    /// It has a name, a password or a fragment in it.
    Credentials,
    /// Its host is not a known push service and not on the operator's list.
    HostNotListed,
    /// It names a port that is not the default one for a known push service.
    Port,
}

impl Refusal {
    /// A plain sentence for the person.
    pub fn sentence(self) -> &'static str {
        match self {
            Self::Malformed => "That push address is not valid.",
            Self::NotHttps => "That push address must be a secure web address.",
            Self::Credentials => "That push address must not carry a name or a password.",
            Self::HostNotListed => "That push service is not supported on this server.",
            Self::Port => "That push address uses a port that is not allowed.",
        }
    }
}

/// An endpoint that passed [`check_endpoint`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The address as given (what is stored).
    pub url: Url,
    /// The host in lower case.
    pub host: String,
    /// The port the connection goes to.
    pub port: u16,
    /// Whether the operator listed this host: it may be plain `http` and may resolve to a private address.
    pub listed_by_operator: bool,
}

impl Endpoint {
    /// The origin a VAPID token is bound to: `scheme://host[:port]`, the port only when it is not the default.
    pub fn origin(&self) -> String {
        let default = if self.url.scheme() == "https" {
            443
        } else {
            80
        };
        if self.port == default {
            format!("{}://{}", self.url.scheme(), self.host)
        } else {
            format!("{}://{}:{}", self.url.scheme(), self.host, self.port)
        }
    }
}

fn known(host: &str) -> bool {
    KNOWN_HOSTS
        .iter()
        .any(|pattern| match pattern.strip_prefix("*.") {
            Some(suffix) => host
                .strip_suffix(suffix)
                .is_some_and(|front| front.len() > 1 && front.ends_with('.')),
            None => host == *pattern,
        })
}

/// Whether `host[:port]` is in the operator's list (exact entries, lower case; an entry without a port matches the host on
/// any port).
fn operator_listed(host: &str, port: u16, extra: &[String]) -> bool {
    extra
        .iter()
        .any(|entry| entry == host || *entry == format!("{host}:{port}"))
}

/// Check a subscription address: the rules above, without touching the network.
pub fn check_endpoint(text: &str, extra: &[String]) -> Result<Endpoint, Refusal> {
    if text.is_empty() || text.len() > ENDPOINT_MAX || text.chars().any(|c| c.is_control()) {
        return Err(Refusal::Malformed);
    }
    let url = Url::parse(text).map_err(|_| Refusal::Malformed)?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Refusal::Credentials);
    }
    let host = match url.host() {
        Some(Host::Domain(name)) => name.to_ascii_lowercase(),
        Some(Host::Ipv4(a)) => a.to_string(),
        Some(Host::Ipv6(a)) => a.to_string(),
        None => return Err(Refusal::Malformed),
    };
    let port = url.port_or_known_default().ok_or(Refusal::Malformed)?;
    let listed = operator_listed(&host, port, extra);
    match url.scheme() {
        "https" => {}
        "http" if listed => {}
        "http" => return Err(Refusal::NotHttps),
        _ => return Err(Refusal::NotHttps),
    }
    if listed {
        return Ok(Endpoint {
            url,
            host,
            port,
            listed_by_operator: true,
        });
    }
    // A known push service: a name (never a bare address), on the default port.
    if !matches!(url.host(), Some(Host::Domain(_))) || !known(&host) {
        return Err(Refusal::HostNotListed);
    }
    if url.port().is_some_and(|p| p != 443) {
        return Err(Refusal::Port);
    }
    Ok(Endpoint {
        url,
        host,
        port,
        listed_by_operator: false,
    })
}

/// Whether an address is one the public internet routes to: not loopback, private, link-local, unspecified, shared
/// (carrier-grade), documentation, multicast, broadcast, or an IPv6 address that maps or embeds one of those.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => public_v4(a),
        IpAddr::V6(a) => public_v6(a),
    }
}

fn public_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    !(a.is_loopback()
        || a.is_private()
        || a.is_link_local()
        || a.is_unspecified()
        || a.is_broadcast()
        || a.is_multicast()
        || a.is_documentation()
        || o[0] == 0
        // 100.64.0.0/10 shared address space
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        // 192.0.0.0/24 protocol assignments, 198.18.0.0/15 benchmarking
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        // 240.0.0.0/4 reserved
        || o[0] >= 240)
}

fn public_v6(a: Ipv6Addr) -> bool {
    if let Some(mapped) = a.to_ipv4_mapped() {
        return public_v4(mapped);
    }
    let s = a.segments();
    // 64:ff9b::/96 (NAT64) embeds an IPv4 address in the last 32 bits.
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|&x| x == 0) {
        let embedded = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return public_v4(embedded);
    }
    !(a.is_loopback()
        || a.is_unspecified()
        || a.is_multicast()
        // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xffc0) == 0xfec0
        // 2001:db8::/32 documentation, 2002::/16 6to4 (embeds an IPv4 address)
        || (s[0] == 0x2001 && s[1] == 0x0db8)
        || s[0] == 0x2002)
}

/// The address a message to `endpoint` is sent to, or `None` when every address its host resolves to is refused. Only the
/// operator's own listed hosts may resolve to a non-public address. The caller connects to the returned address and no
/// other (it is handed to the HTTP client), so the answer cannot change between this check and the connection.
pub fn pick_address(endpoint: &Endpoint, resolved: &[IpAddr]) -> Option<SocketAddr> {
    resolved
        .iter()
        .copied()
        .find(|ip| endpoint.listed_by_operator || is_public(*ip))
        .map(|ip| SocketAddr::new(ip, endpoint.port))
}

/// Resolve the endpoint's host now and pick the address to connect to ([`pick_address`]). An address literal is its own
/// answer.
pub async fn resolve(endpoint: &Endpoint) -> Result<Option<SocketAddr>, std::io::Error> {
    if let Ok(ip) = endpoint.host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return Ok(pick_address(endpoint, &[ip]));
    }
    let found: Vec<IpAddr> = tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
        .await?
        .map(|a| a.ip())
        .collect();
    Ok(pick_address(endpoint, &found))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extra() -> Vec<String> {
        vec!["127.0.0.1:34567".to_owned(), "standin.test".to_owned()]
    }

    #[test]
    fn the_known_services_pass_and_everything_else_is_refused() {
        for good in [
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://updates.push.services.mozilla.com/wpush/v2/abcdef",
            "https://web.push.apple.com/QGd8mA1",
            "https://db5p.notify.windows.com/w/?token=abc",
        ] {
            assert!(check_endpoint(good, &[]).is_ok(), "{good}");
        }
        let cases = [
            ("http://fcm.googleapis.com/x", Refusal::NotHttps),
            ("ftp://fcm.googleapis.com/x", Refusal::NotHttps),
            (
                "https://user:pass@fcm.googleapis.com/x",
                Refusal::Credentials,
            ),
            ("https://user@fcm.googleapis.com/x", Refusal::Credentials),
            ("https://fcm.googleapis.com/x#frag", Refusal::Credentials),
            ("https://example.com/x", Refusal::HostNotListed),
            (
                "https://evilfcm.googleapis.com.example.com/x",
                Refusal::HostNotListed,
            ),
            ("https://notfcm.googleapis.com/x", Refusal::HostNotListed),
            ("https://push.apple.com/x", Refusal::HostNotListed),
            ("https://evilpush.apple.com/x", Refusal::HostNotListed),
            ("https://127.0.0.1/x", Refusal::HostNotListed),
            (
                "https://169.254.169.254/latest/meta-data",
                Refusal::HostNotListed,
            ),
            ("https://[::1]/x", Refusal::HostNotListed),
            ("https://localhost/x", Refusal::HostNotListed),
            ("https://fcm.googleapis.com:8443/x", Refusal::Port),
            ("not a url", Refusal::Malformed),
            ("", Refusal::Malformed),
            ("https://fcm.googleapis.com/\nx", Refusal::Malformed),
        ];
        for (text, why) in cases {
            assert_eq!(check_endpoint(text, &[]).err(), Some(why), "{text}");
        }
        let long = format!("https://fcm.googleapis.com/{}", "a".repeat(ENDPOINT_MAX));
        assert_eq!(check_endpoint(&long, &[]).err(), Some(Refusal::Malformed));
        let at_limit = format!(
            "https://fcm.googleapis.com/{}",
            "a".repeat(ENDPOINT_MAX - 27)
        );
        assert_eq!(at_limit.len(), ENDPOINT_MAX);
        assert!(check_endpoint(&at_limit, &[]).is_ok());
    }

    #[test]
    fn only_a_listed_host_may_be_plain_http_or_a_private_address() {
        let ok = check_endpoint("http://127.0.0.1:34567/push/1", &extra()).expect("listed");
        assert!(ok.listed_by_operator);
        assert_eq!(ok.origin(), "http://127.0.0.1:34567");
        // The same host on another port is not the listed one.
        assert_eq!(
            check_endpoint("http://127.0.0.1:9/x", &extra()).err(),
            Some(Refusal::NotHttps)
        );
        assert_eq!(
            check_endpoint("https://127.0.0.1:9/x", &extra()).err(),
            Some(Refusal::HostNotListed)
        );
        // A host listed without a port matches on every port.
        assert!(check_endpoint("http://standin.test:8080/x", &extra()).is_ok());
        // A listed entry does not widen to its neighbours.
        assert_eq!(
            check_endpoint("http://other.standin.test/x", &extra()).err(),
            Some(Refusal::NotHttps)
        );
    }

    #[test]
    fn private_loopback_and_link_local_addresses_are_not_public() {
        for text in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "2001:db8::1",
            "ff02::1",
        ] {
            assert!(!is_public(text.parse().expect("address")), "{text}");
        }
        for text in [
            "8.8.8.8",
            "142.250.80.46",
            "172.15.0.1",
            "172.32.0.1",
            "2607:f8b0:4004::200e",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public(text.parse().expect("address")), "{text}");
        }
    }

    /// The name is resolved when sending and the connection goes to the address that passed: a name that resolves to the
    /// server's own network is refused, one with a public answer among private ones picks the public one, and only the
    /// operator's listed host may keep a private answer.
    #[test]
    fn the_address_that_passes_is_the_one_connected_to() {
        let known = check_endpoint("https://fcm.googleapis.com/x", &[]).expect("known");
        let private: IpAddr = "10.0.0.5".parse().expect("ip");
        let public: IpAddr = "142.250.80.46".parse().expect("ip");
        assert_eq!(pick_address(&known, &[private]), None);
        assert_eq!(
            pick_address(&known, &[private, "127.0.0.1".parse().expect("ip")]),
            None
        );
        assert_eq!(
            pick_address(&known, &[private, public]),
            Some(SocketAddr::new(public, 443))
        );
        assert_eq!(pick_address(&known, &[]), None);
        let listed = check_endpoint("http://127.0.0.1:34567/x", &extra()).expect("listed");
        assert_eq!(
            pick_address(&listed, &["127.0.0.1".parse().expect("ip")]),
            Some("127.0.0.1:34567".parse().expect("socket address"))
        );
    }
}
