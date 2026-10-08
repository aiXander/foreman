// Hash routing: #/ overview, #/s/<session>, #/t/<terminal>, #/page/<pin>, #/launch.
import { useEffect, useState } from "react";

export type Route =
  | { name: "overview" }
  | { name: "session"; id: string }
  | { name: "terminal"; id: string }
  | { name: "page"; id: string }
  | { name: "launch" };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts[1]) return { name: "session", id: parts[1] };
  if (parts[0] === "t" && parts[1]) return { name: "terminal", id: parts[1] };
  if (parts[0] === "page" && parts[1]) return { name: "page", id: parts[1] };
  if (parts[0] === "launch") return { name: "launch" };
  return { name: "overview" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "overview":
      return "#/";
    case "launch":
      return "#/launch";
    case "session":
      return `#/s/${encodeURIComponent(r.id)}`;
    case "terminal":
      return `#/t/${encodeURIComponent(r.id)}`;
    case "page":
      return `#/page/${encodeURIComponent(r.id)}`;
  }
}

export function navigate(r: Route): void {
  location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
