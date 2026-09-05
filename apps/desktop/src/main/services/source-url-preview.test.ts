import { describe, expect, it } from "vitest";
import { isPublicAddress, youtubeIdFromUrl } from "./source-url-preview.js";

describe("manual source URL previews", () => {
  it("rejects loopback, private, link-local and IPv4-mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("accepts YouTube watch, short and embedded identifiers without accepting lookalike hosts", () => {
    for (const url of ["https://www.youtube.com/watch?v=abcdefghijk", "https://youtu.be/abcdefghijk", "https://youtube.com/shorts/abcdefghijk", "https://youtube.com/embed/abcdefghijk"]) {
      expect(youtubeIdFromUrl(url)).toBe("abcdefghijk");
    }
    for (const url of ["https://youtube.com.attacker.example/watch?v=abcdefghijk", "http://youtube.com/watch?v=abcdefghijk", "https://youtube.com:444/watch?v=abcdefghijk", "https://user:pass@youtube.com/watch?v=abcdefghijk", "https://youtube.com/watch?v=invalid"]) {
      expect(youtubeIdFromUrl(url)).toBeNull();
    }
  });
});
