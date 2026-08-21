cmake_minimum_required(VERSION 3.25)

project(chrome_control_mcp VERSION 1.0.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "chrome-control-mcp uses Windows named-pipe and native messaging APIs.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_AUTOMOC OFF)

find_package(Qt6 6.5 REQUIRED COMPONENTS Core)

set(CCMCP_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(CCMCP_CORE_SOURCES
    src/browser_bridge.cpp
    src/browser_bridge_pipe.cpp
    src/browser_bridge_relay.cpp
    src/browser_bridge_security.cpp
    src/browser_contract.cpp
    src/browser_control.cpp
    src/browser_extension_installer.cpp
    src/native_messaging.cpp
)

add_library(chrome_control_mcp_core STATIC ${CCMCP_CORE_SOURCES})
target_include_directories(chrome_control_mcp_core PUBLIC ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp_core PUBLIC Qt6::Core advapi32 shell32 user32)
target_compile_definitions(chrome_control_mcp_core PUBLIC UNICODE _UNICODE)

add_executable(chrome_control_mcp
    src/main.cpp
    src/browser_mcp_tools.cpp
    src/mcp_dispatch.cpp
    src/mcp_entry.cpp
)
target_include_directories(chrome_control_mcp PRIVATE ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp PRIVATE chrome_control_mcp_core Qt6::Core)
target_compile_definitions(chrome_control_mcp PRIVATE UNICODE _UNICODE)

if(MSVC)
    target_compile_options(chrome_control_mcp_core PRIVATE /W4 /permissive- /utf-8)
    target_compile_options(chrome_control_mcp PRIVATE /W4 /permissive- /utf-8)
endif()

add_custom_command(TARGET chrome_control_mcp POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension"
            "$<TARGET_FILE_DIR:chrome_control_mcp>/extension"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:Qt6::Core>"
            "$<TARGET_FILE_DIR:chrome_control_mcp>"
    COMMENT "Staging unpacked browser extension and Qt runtime"
)

install(TARGETS chrome_control_mcp RUNTIME DESTINATION .)
install(FILES
    "$<TARGET_FILE:Qt6::Core>"
    "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE"
    DESTINATION .
)
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension/" DESTINATION extension)

include(CTest)
if(BUILD_TESTING)
    find_package(Qt6 6.5 REQUIRED COMPONENTS Test)

    function(configure_qt_test target)
        set_target_properties(${target} PROPERTIES AUTOMOC ON)
        target_include_directories(${target} PRIVATE ${CCMCP_INCLUDE_DIR})
        target_compile_definitions(${target} PRIVATE UNICODE _UNICODE)
        if(MSVC)
            target_compile_options(${target} PRIVATE /W4 /permissive- /utf-8)
        endif()
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "$<TARGET_FILE:Qt6::Core>" "$<TARGET_FILE_DIR:${target}>"
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "$<TARGET_FILE:Qt6::Test>" "$<TARGET_FILE_DIR:${target}>"
        )
        add_test(NAME ${target} COMMAND ${target})
    endfunction()

    add_executable(test_browser_contract
        tests/test_browser_contract.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_contract PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_contract)

    add_executable(test_native_messaging
        tests/test_native_messaging.cpp
        src/native_messaging.cpp
        src/native_host.cpp
    )
    target_link_libraries(test_native_messaging PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_native_messaging)

    add_executable(test_browser_bridge
        tests/test_browser_bridge.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_bridge PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_bridge)

    add_executable(test_browser_extension_installer
        tests/test_browser_extension_installer.cpp
        src/browser_extension_installer.cpp
    )
    target_link_libraries(test_browser_extension_installer PRIVATE Qt6::Core Qt6::Test advapi32)
    target_compile_definitions(test_browser_extension_installer PRIVATE
        CHROME_CONTROL_MCP_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
        CHROME_CONTROL_MCP_WIN_REGISTRY_TESTS
    )
    configure_qt_test(test_browser_extension_installer)

    add_executable(test_browser_bridge_security
        tests/test_browser_bridge_security.cpp
        src/browser_bridge_security.cpp
    )
    target_link_libraries(test_browser_bridge_security PRIVATE Qt6::Core Qt6::Test advapi32)
    configure_qt_test(test_browser_bridge_security)

    add_executable(test_browser_bridge_pipe
        tests/test_browser_bridge_pipe.cpp
        src/browser_bridge_pipe.cpp
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_pipe PRIVATE Qt6::Core Qt6::Test advapi32)
    configure_qt_test(test_browser_bridge_pipe)

    add_executable(test_browser_bridge_relay
        tests/test_browser_bridge_relay.cpp
        src/browser_bridge_relay.cpp
        src/browser_control.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
        src/browser_bridge_pipe.cpp
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_relay PRIVATE Qt6::Core Qt6::Test advapi32)
    configure_qt_test(test_browser_bridge_relay)

    add_executable(test_browser_mcp_server
        tests/test_browser_mcp_server.cpp
        src/browser_mcp_tools.cpp
        src/mcp_dispatch.cpp
    )
    target_link_libraries(test_browser_mcp_server PRIVATE
        chrome_control_mcp_core Qt6::Core Qt6::Test
    )
    configure_qt_test(test_browser_mcp_server)

    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    add_test(NAME test_browser_extension_pure
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_pure.mjs"
    )
    set_tests_properties(test_browser_extension_pure PROPERTIES TIMEOUT 120)
endif()
