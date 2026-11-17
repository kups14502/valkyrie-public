// The floor: one-meter grid lines in the accent color, fading out with distance.
shader_type spatial;
render_mode unshaded, cull_disabled, blend_mix, depth_draw_never, shadows_disabled;

uniform vec4 line_color : source_color = vec4(0.0, 1.0, 0.255, 0.22);

void fragment() {
	vec3 world = (INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz;
	vec2 p = world.xz;
	vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
	float line = 1.0 - min(min(g.x, g.y), 1.0);
	float fade = 1.0 - smoothstep(3.0, 16.0, length(p - CAMERA_POSITION_WORLD.xz));
	ALBEDO = line_color.rgb;
	ALPHA = line * line_color.a * fade;
}
