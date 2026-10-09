import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const CANONICAL = "www.trybes.si";

export function middleware(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":")[0];
  if (host === CANONICAL) return NextResponse.next();
  if (host !== "trybes.si" && !host.endsWith(".vercel.app")) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.protocol = "https:";
  url.host = CANONICAL;
  url.port = "";
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
